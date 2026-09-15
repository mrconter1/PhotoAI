import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GOOGLE_SIZES, Provider, openaiQuality, openaiSize, providerOf } from "@/lib/providers";

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
  file: Blob;
  mimeType: string;
  prompt: string;
  model: string;
  aspectRatio: string; // "w:h" or "" for match input
  imageSize: string; // Google: 1K/2K/4K; OpenAI: low/medium/high; "" = default
};

async function editWithGoogle(apiKey: string, e: Edit) {
  const data = Buffer.from(await e.file.arrayBuffer()).toString("base64");

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
        parts: [{ inlineData: { mimeType: e.mimeType, data } }, { text: e.prompt }],
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
  const ext = e.mimeType === "image/jpeg" ? "jpg" : e.mimeType === "image/webp" ? "webp" : "png";
  const size = openaiSize(e.aspectRatio);
  const quality = openaiQuality(e.imageSize);

  const send = async (fidelity: boolean) => {
    const form = new FormData();
    form.append("model", e.model);
    form.append("image[]", new File([e.file], `image.${ext}`, { type: e.mimeType }));
    form.append("prompt", e.prompt);
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
  const prompt = String(form.get("prompt") ?? "").trim();
  const model = String(form.get("model") ?? "") || DEFAULT_MODEL;
  const provider = (String(form.get("provider") ?? "") as Provider) || providerOf(model);
  const aspectRatio = String(form.get("aspectRatio") ?? "");
  const imageSize = String(form.get("imageSize") ?? "");

  if (!(file instanceof Blob)) return fail("No image was uploaded.", 400);
  if (!prompt) return fail("Describe the edit you want.", 400);
  if (file.size === 0) return fail("The uploaded image was empty.", 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit for an AI edit.`,
      413
    );
  }

  const mimeType = ACCEPTED.includes(file.type) ? file.type : "image/png";
  const edit: Edit = { file, mimeType, prompt, model, aspectRatio, imageSize };

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
