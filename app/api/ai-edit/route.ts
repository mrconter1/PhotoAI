import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

// Node runtime: keeps the API key server-side and handles larger payloads.
export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.GOOGLE_IMAGE_MODEL || "gemini-3-pro-image";

type Body = {
  // data URL: "data:image/png;base64,...."
  image: string;
  prompt: string;
};

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_API_KEY is not set. Copy .env.local.example to .env.local and add your key." },
      { status: 500 }
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { image, prompt } = body;
  if (!image || !prompt?.trim()) {
    return NextResponse.json({ error: "Both 'image' and 'prompt' are required." }, { status: 400 });
  }

  const parsed = parseDataUrl(image);
  if (!parsed) {
    return NextResponse.json({ error: "Image must be a base64 data URL." }, { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: parsed.mimeType, data: parsed.data } },
            { text: prompt },
          ],
        },
      ],
    });

    // Find the first returned image part.
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || "image/png";
        return NextResponse.json({
          image: `data:${mime};base64,${part.inlineData.data}`,
        });
      }
    }

    // No image came back; surface any text the model returned.
    const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
    return NextResponse.json(
      { error: text || "The model did not return an image. Try a more specific edit prompt." },
      { status: 502 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error calling Google AI.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
