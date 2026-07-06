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

## Setup

```bash
npm install
cp .env.local.example .env.local   # add your GOOGLE_API_KEY
npm run dev
```

Get an API key at https://aistudio.google.com/apikey.
The default model is `gemini-3.1-flash-image` (override with `GOOGLE_IMAGE_MODEL`,
or pick any available model in the app's AI Settings tab).

## Notes

- Adjust/crop/transform work fully offline. Only **AI Edit** needs the API key.
- Everything stays in the browser except the AI request.
