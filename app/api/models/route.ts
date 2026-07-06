import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Lists the account's image-capable Gemini models via the ListModels REST API.
export async function GET() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_API_KEY is not set." }, { status: 500 });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data?.error?.message || "Failed to list models." }, { status: 502 });
    }

    type Model = { name: string; displayName?: string; supportedGenerationMethods?: string[] };
    const models: string[] = (data.models ?? [])
      .filter(
        (m: Model) =>
          m.name?.includes("image") &&
          (m.supportedGenerationMethods ?? []).includes("generateContent")
      )
      .map((m: Model) => m.name.replace(/^models\//, ""));

    // Ensure the configured default is present even if filtering missed it.
    const preferred = process.env.GOOGLE_IMAGE_MODEL || "gemini-3.1-flash-image";
    if (!models.includes(preferred)) models.unshift(preferred);

    return NextResponse.json({ models, default: preferred });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
