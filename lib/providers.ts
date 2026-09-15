// What the client and the API routes both need to know about the two image
// providers. Nothing here touches a key; keys stay in the routes.

export type Provider = "google" | "openai";
export type ModelInfo = { id: string; provider: Provider };

export const PROVIDER_NAME: Record<Provider, string> = { google: "Google", openai: "OpenAI" };

/** A model's provider, read off its name. OpenAI's image models are all gpt-image-* (dall-e-* before that). */
export function providerOf(model: string): Provider {
  return /^(gpt-image|dall-e)/i.test(model) ? "openai" : "google";
}

// Google takes an aspect ratio and a resolution tier; OpenAI takes a pixel
// size and a quality tier. The same two settings are kept for both and read
// per provider, so switching models does not need a second set of fields.

/** The aspect ratios a Google model accepts, as sent. "" = match the input. */
export const GOOGLE_ASPECTS = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
export const GOOGLE_SIZES = ["1K", "2K", "4K"]; // "" = model default

/**
 * OpenAI's three fixed sizes, which every gpt-image model accepts (the newer
 * ones also take arbitrary WIDTHxHEIGHT, the older ones do not). The aspect
 * setting is mapped to whichever is nearest, so a fill that asks for 16:9
 * still comes back landscape.
 */
export const OPENAI_ASPECTS: { value: string; label: string }[] = [
  { value: "", label: "Match input" },
  { value: "1:1", label: "Square (1024 × 1024)" },
  { value: "3:2", label: "Landscape (1536 × 1024)" },
  { value: "2:3", label: "Portrait (1024 × 1536)" },
];
export const OPENAI_QUALITIES: { value: string; label: string }[] = [
  { value: "", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** The `size` to send OpenAI for an aspect setting (any "w:h" string, or "" for auto). */
export function openaiSize(aspect: string): "auto" | "1024x1024" | "1536x1024" | "1024x1536" {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (!m) return "auto";
  const r = Number(m[1]) / Number(m[2]);
  if (!Number.isFinite(r) || r <= 0) return "auto";
  if (r > 1.15) return "1536x1024";
  if (r < 1 / 1.15) return "1024x1536";
  return "1024x1024";
}

/** The `quality` to send OpenAI for the size/quality setting; anything not its own is auto. */
export function openaiQuality(size: string): string {
  return OPENAI_QUALITIES.some((q) => q.value === size && q.value) ? size : "auto";
}
