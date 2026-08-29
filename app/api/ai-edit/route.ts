import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

// Node runtime: keeps the API key server-side and handles larger payloads.
export const runtime = "nodejs";
// Fluid Compute allows 300s on every plan; image models can take a while at 4K.
export const maxDuration = 300;

const DEFAULT_MODEL = process.env.GOOGLE_IMAGE_MODEL || "gemini-3.1-flash-image";

// The client downscales to a few MB before uploading (lib/image.ts). This is a
// backstop so a hand-rolled request cannot push a 100 MB frame into the model.
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return fail(
      "GOOGLE_API_KEY is not set. Add it in the Vercel project settings (or .env.local when running locally).",
      500
    );
  }

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
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");

  // Optional image config (aspect ratio / resolution) — only sent when set.
  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  const config = Object.keys(imageConfig).length > 0 ? { imageConfig } : undefined;

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data } }, { text: prompt }],
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
        const bytes = Buffer.from(part.inlineData.data, "base64");
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: {
            "Content-Type": part.inlineData.mimeType || "image/png",
            "Content-Length": String(bytes.byteLength),
            "Cache-Control": "no-store",
          },
        });
      }
    }

    // No image came back; surface any text the model returned.
    const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
    return fail(text || "The model did not return an image. Try a more specific edit prompt.", 502);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error calling Google AI.";
    return fail(message, 502);
  }
}
