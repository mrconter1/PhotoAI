import { NextResponse } from "next/server";
import { ModelInfo } from "@/lib/providers";

export const runtime = "nodejs";

const DEFAULT_GOOGLE = "gemini-3.1-flash-image";

// Lists the account's image-capable Gemini models via the ListModels REST API.
async function googleModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`, {
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Google: failed to list models.");

  type Model = { name: string; supportedGenerationMethods?: string[] };
  return (data.models ?? [])
    .filter(
      (m: Model) => m.name?.includes("image") && (m.supportedGenerationMethods ?? []).includes("generateContent")
    )
    .map((m: Model) => m.name.replace(/^models\//, ""));
}

// Lists the account's gpt-image models. /v1/models returns everything the key
// can reach, chat models included; only the image family is wanted here, and
// the dated snapshots (gpt-image-2-2026-04-21) are dropped in favour of their
// alias so the list reads as choices rather than as a changelog.
async function openaiModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "OpenAI: failed to list models.");

  type Model = { id: string };
  return (data.data ?? [])
    .map((m: Model) => m.id)
    .filter((id: string) => /^gpt-image/.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id))
    .sort();
}

/**
 * Every image model the configured keys can reach, Google first, each tagged
 * with its provider. A provider without a key is simply absent; one whose
 * listing fails is reported in `errors` rather than taking the other down
 * with it.
 */
export async function GET() {
  const google = process.env.GOOGLE_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  if (!google && !openai) {
    return NextResponse.json({ error: "Neither GOOGLE_API_KEY nor OPENAI_API_KEY is set." }, { status: 500 });
  }

  const models: ModelInfo[] = [];
  const errors: string[] = [];

  const [g, o] = await Promise.allSettled([
    google ? googleModels(google) : Promise.resolve([]),
    openai ? openaiModels(openai) : Promise.resolve([]),
  ]);

  if (g.status === "fulfilled") {
    const ids = g.value;
    // Ensure the configured default is present even if filtering missed it.
    const preferred = process.env.GOOGLE_IMAGE_MODEL || DEFAULT_GOOGLE;
    if (google && !ids.includes(preferred)) ids.unshift(preferred);
    models.push(...ids.map((id) => ({ id, provider: "google" as const })));
  } else errors.push(String(g.reason?.message ?? g.reason));

  if (o.status === "fulfilled") models.push(...o.value.map((id) => ({ id, provider: "openai" as const })));
  else errors.push(String(o.reason?.message ?? o.reason));

  if (!models.length) {
    return NextResponse.json({ error: errors.join(" ") || "No image models available." }, { status: 502 });
  }

  const preferred = google ? process.env.GOOGLE_IMAGE_MODEL || DEFAULT_GOOGLE : models[0].id;
  return NextResponse.json({
    models,
    default: preferred,
    providers: { google: !!google, openai: !!openai },
    ...(errors.length ? { errors } : {}),
  });
}
