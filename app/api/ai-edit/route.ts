import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GOOGLE_SIZES, MAX_REFERENCES, Provider, openaiQuality, openaiSize, providerOf } from "@/lib/providers";

// Node runtime: keeps the API keys server-side and handles larger payloads.
export const runtime = "nodejs";
// Fluid Compute allows 300s on every plan; image models can take a while at 4K.
export const maxDuration = 300;

const DEFAULT_MODEL = process.env.GOOGLE_IMAGE_MODEL || "gemini-3.1-flash-image";

// The client compresses to ~3.5 MB before uploading (lib/image.ts), and the
// platform refuses anything past 4.5 MB before this route runs. This is the
// backstop for whatever slips between the two.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp" };

/** An uploaded image with the type the model should be told it is. */
type Upload = { file: Blob; mimeType: string };

function upload(file: Blob): Upload {
  return { file, mimeType: ACCEPTED.includes(file.type) ? file.type : "image/png" };
}

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

/** Raw image bytes back to the client, no base64 envelope. */
function imageResponse(bytes: Buffer, mime: string) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}

type Edit = {
  image: Upload;
  /** Extra images the prompt can point at: a face, a product, a style. */
  references: Upload[];
  prompt: string;
  model: string;
  aspectRatio: string; // "w:h" or "" for match input
  imageSize: string; // Google: 1K/2K/4K; OpenAI: low/medium/high; "" = default
};

/**
 * The prompt as the model sees it. With references attached it has to be told
 * which image is the one being edited - both APIs take a flat list, and left
 * to guess, a model will as happily redraw the reference as the photo.
 */
function framePrompt(e: Edit): string {
  const n = e.references.length;
  if (!n) return e.prompt;
  const which = n === 1 ? "The second image is a reference" : `The other ${n} images are references`;
  return (
    `The first image is the photo to edit; return that photo with the change applied, keeping its framing. ` +
    `${which} supplied by the user - use ${n === 1 ? "it" : "them"} only as the instruction asks, and do not return ${n === 1 ? "it" : "them"} as the result.

` +
    e.prompt
  );
}

const inline = async (u: Upload) => ({
  inlineData: { mimeType: u.mimeType, data: Buffer.from(await u.file.arrayBuffer()).toString("base64") },
});

async function editWithGoogle(apiKey: string, e: Edit) {
  const images = await Promise.all([e.image, ...e.references].map(inline));

  // Optional image config (aspect ratio / resolution) - only sent when set.
  // A size tier that is not Google's (an OpenAI quality left over from a
  // model switch) is dropped rather than sent: Google answers it with a 400.
  const imageConfig: Record<string, string> = {};
  if (e.aspectRatio) imageConfig.aspectRatio = e.aspectRatio;
  if (GOOGLE_SIZES.includes(e.imageSize)) imageConfig.imageSize = e.imageSize;
  const config = Object.keys(imageConfig).length > 0 ? { imageConfig } : undefined;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: e.model,
    contents: [
      {
        role: "user",
        parts: [...images, { text: framePrompt(e) }],
      },
    ],
    ...(config ? { config } : {}),
  });

  // Find the first returned image part and stream it back as raw bytes: a
  // 4K result is several MB, which is past the JSON response budget once
  // base64 has added its third on top.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return imageResponse(Buffer.from(part.inlineData.data, "base64"), part.inlineData.mimeType || "image/png");
    }
  }

  // No image came back; surface any text the model returned.
  const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
  return fail(text || "The model did not return an image. Try a more specific edit prompt.", 502);
}

/**
 * OpenAI's images/edits endpoint. Multipart in, base64 JSON out. The three
 * fixed sizes are used because every gpt-image model takes them; the newer
 * ones would also accept the photo's exact shape, the older ones would not.
 *
 * input_fidelity=high keeps faces and detail from the input, which for a photo
 * editor is the point. Not every model accepts it, and the API answers an
 * unknown parameter with a 400 rather than ignoring it - so it is tried first
 * and dropped on that one refusal.
 */
async function editWithOpenAI(apiKey: string, e: Edit) {
  const size = openaiSize(e.aspectRatio);
  const quality = openaiQuality(e.imageSize);

  const send = async (fidelity: boolean) => {
    const form = new FormData();
    form.append("model", e.model);
    // The photo goes first: images/edits edits the first image and reads the
    // rest as input, which is the order framePrompt describes.
    [e.image, ...e.references].forEach((u, i) =>
      form.append("image[]", new File([u.file], `${i ? `reference-${i}` : "image"}.${EXT[u.mimeType] ?? "png"}`, { type: u.mimeType }))
    );
    form.append("prompt", framePrompt(e));
    form.append("size", size);
    form.append("quality", quality);
    form.append("output_format", "png");
    form.append("n", "1");
    if (fidelity) form.append("input_fidelity", "high");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  };

  let { res, body } = await send(true);
  if (!res.ok && res.status === 400 && /input_fidelity/i.test(String(body?.error?.message ?? ""))) {
    ({ res, body } = await send(false));
  }
  if (!res.ok) {
    return fail(body?.error?.message || `OpenAI request failed (${res.status}).`, res.status === 401 ? 500 : 502);
  }

  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) return fail("The model did not return an image. Try a more specific edit prompt.", 502);
  const format = body?.output_format || "png";
  return imageResponse(Buffer.from(b64, "base64"), format === "jpeg" ? "image/jpeg" : `image/${format}`);
}

export async function POST(req: NextRequest) {
  // multipart/form-data, so the image travels as raw bytes. Base64 in JSON
  // inflates every upload by a third and makes large photos needlessly slow.
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return fail("Send multipart/form-data with an 'image' file and a 'prompt' field.", 415);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("Could not read the upload. The image may be too large.", 413);
  }

  const file = form.get("image");
  const references = form.getAll("reference").filter((r): r is File => r instanceof Blob && r.size > 0);
  const prompt = String(form.get("prompt") ?? "").trim();
  const model = String(form.get("model") ?? "") || DEFAULT_MODEL;
  const provider = (String(form.get("provider") ?? "") as Provider) || providerOf(model);
  const aspectRatio = String(form.get("aspectRatio") ?? "");
  const imageSize = String(form.get("imageSize") ?? "");

  if (!(file instanceof Blob)) return fail("No image was uploaded.", 400);
  if (!prompt) return fail("Describe the edit you want.", 400);
  if (file.size === 0) return fail("The uploaded image was empty.", 400);
  if (references.length > MAX_REFERENCES) {
    return fail(`At most ${MAX_REFERENCES} reference images can go with one edit.`, 400);
  }
  const total = references.reduce((sum, r) => sum + r.size, file.size);
  if (total > MAX_UPLOAD_BYTES) {
    return fail(
      `The upload is ${(total / 1024 / 1024).toFixed(1)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit for an AI edit.`,
      413
    );
  }

  const edit: Edit = {
    image: upload(file),
    references: references.map(upload),
    prompt,
    model,
    aspectRatio,
    imageSize,
  };

  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY";
  const apiKey = process.env[keyName];
  if (!apiKey) {
    return fail(`${keyName} is not set. Add it in the Vercel project settings (or .env.local when running locally).`, 500);
  }

  try {
    return provider === "openai" ? await editWithOpenAI(apiKey, edit) : await editWithGoogle(apiKey, edit);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `Unknown error calling ${provider === "openai" ? "OpenAI" : "Google AI"}.`;
    return fail(message, 502);
  }
}
