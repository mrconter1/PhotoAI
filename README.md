# PhotoAI

A fast, desktop-first photo editor with AI edits. Crop and adjust locally on
GPU-accelerated canvas, then send the image to Google's image model for
generative edits and compare before/after.

## Features

- **Open** via drag-and-drop or file picker
- **Adjust** — brightness, contrast, saturation, warmth, grayscale, blur (live CSS-filter preview, baked on apply)
- **Transform** — rotate 90°, flip horizontal/vertical
- **Crop** — interactive rule-of-thirds crop with corner handles
- **AI Edit** — describe a change; the photo is sent to Google's image model and returned as a new layer
- **Compare** — before/after slider
- **Undo/redo** history (Ctrl+Z / Ctrl+Y) and PNG export

## Architecture

- **Next.js (App Router) + React 19**. All editing runs client-side for speed;
  the only server code is `app/api/ai-edit/route.ts`, which keeps the Google API
  key server-side and proxies the request.
- Live adjustments use CSS `filter` (GPU) for smooth interaction; committing an
  edit bakes it into a fresh PNG via canvas (`lib/image.ts`) and pushes it onto
  the history stack.

## Large photos

Camera files are tens of megapixels, so the parts that scale badly are handled
explicitly rather than left to chance:

- **Object URLs, not data URLs.** Images are held as `blob:` URLs. A 24 MP photo
  is ~30 MB as a PNG blob plus another ~40 MB again as base64, and the old
  data-URL history could exhaust the tab after a few edits. Blobs live outside
  the JS heap, and every URL that leaves the history is revoked.
- **History is capped** at 40 states for the same reason.
- **Oversized photos are downscaled once, on open.** A 2D canvas tops out around
  16384 px per side and returns a *blank* frame past its area limit instead of
  throwing, so anything beyond the budget in `lib/image.ts` is resized on open
  and the app says so.
- **The AI upload is downscaled and compressed**, to 1536-3072 px on the long
  edge depending on the resolution you pick, as WebP under 3.5 MB. WebP keeps
  the transparency a crop-out leaves behind, which JPEG would fill in black.
  The 3.5 MB is measured, not guessed: a request body over 4.5 MB is rejected
  by the platform (`FUNCTION_PAYLOAD_TOO_LARGE`) before the route runs, and the
  multipart envelope needs headroom inside that.
- **The request is multipart, the response is raw bytes.** Base64 in JSON adds a
  third to every byte in both directions; the route takes the image as a file
  field and streams the result back as `image/png`.
- **Platform errors are read as text.** A payload the edge rejects never reaches
  the route and comes back as HTML, so the client only parses JSON when the
  response says it is JSON.

## Setup

```bash
npm install
cp .env.local.example .env.local   # add your GOOGLE_API_KEY
npm run dev
```

Get an API key at https://aistudio.google.com/apikey.
The default model is `gemini-3.1-flash-image` (override with `GOOGLE_IMAGE_MODEL`,
or pick any available model in the app's AI Settings tab).

## Deploy

Deployed on Vercel. `GOOGLE_API_KEY` (and optionally `GOOGLE_IMAGE_MODEL`) must
be set as project environment variables — never in the client bundle.

```bash
vercel link
vercel env add GOOGLE_API_KEY production
vercel --prod
```

`vercel.json` gives `/api/ai-edit` 300 s and 2 GB, which a 4K generation can use.

## Notes

- Adjust/crop/transform work fully offline. Only **AI Edit** needs the API key.
- Everything stays in the browser except the AI request.
