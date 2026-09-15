"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  AI_MAX_EDGE,
  Adjustments,
  CropRect,
  EMPTY_FILL,
  Margins,
  NEUTRAL_ADJUSTMENTS,
  adjustmentsToFilter,
  bakeToUrl,
  canPickSaveLocation,
  clampCrop,
  emptyMargins,
  encodeForUpload,
  exportName,
  fitCropRatio,
  formatBytes,
  loadImage,
  nearestAspect,
  openImageFile,
  revoke,
  saveImageAs,
  scaleCrop,
} from "@/lib/image";
import CropOverlay from "./CropOverlay";
import {
  GOOGLE_ASPECTS,
  GOOGLE_SIZES,
  ModelInfo,
  OPENAI_ASPECTS,
  OPENAI_QUALITIES,
  PROVIDER_NAME,
  providerOf,
} from "@/lib/providers";
import { hint } from "./styles";

// Every entry in the left sidebar is one of three kinds: an action runs at
// once, a popup opens over the sidebar, and these open in the side panel.
type Panel = "crop" | "adjust" | "ai" | null;
type Viewport = { zoom: number; x: number; y: number };

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
// Each history entry is a full-resolution PNG blob, so the depth is bounded:
// 40 steps on a 24 MP photo is already north of a gigabyte of blob storage.
const MAX_HISTORY = 40;
// Versions one Generate may ask for. Four is where the thumbnail strip still
// reads at a glance, and it is four times the cost of one - a cap, not a target.
export const MAX_VERSIONS = 4;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const CROP_RATIOS: [string, number | null][] = [
  ["Free", null],
  ["1:1", 1],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
];

/**
 * Turn a failed /api/ai-edit response into something readable.
 * The route answers JSON, but a payload the platform rejects outright never
 * reaches it - that comes back as HTML or plain text from the edge, so parsing
 * the body as JSON unconditionally would swallow the real reason.
 */
async function errorFromResponse(res: Response): Promise<string> {
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      const data = await res.json();
      if (data?.error) return String(data.error);
    } catch {}
  } else {
    const body = await res.text().catch(() => "");
    const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (plain && res.status !== 413) return plain.slice(0, 200);
  }
  if (res.status === 413) return "The upload was too large. Pick a lower resolution in AI Settings.";
  if (res.status === 504) return "The AI edit timed out. Try a lower resolution or a simpler prompt.";
  return `AI request failed (${res.status}).`;
}

/**
 * The prompt behind "Fill empty space".
 * Outpainting fails far more often from a vague instruction than from a weak
 * model: the request has to say that the grey band is empty, roughly how wide
 * it is on each side, and that the photo itself is not to be touched. The
 * measured margins go in as words because that is the one channel the model
 * cannot misread.
 */
function fillPrompt(margins: Margins | null, extra: string): string {
  const sides = margins
    ? ([
        ["left", margins.left],
        ["right", margins.right],
        ["top", margins.top],
        ["bottom", margins.bottom],
      ] as [string, number][])
        .filter(([, v]) => v > 0.005)
        .map(([side, v]) => `${side} ${Math.round(v * 100)}%`)
        .join(", ")
    : "";

  return [
    "This is a photograph sitting on a larger canvas. The flat grey area around it is empty and has to be filled in.",
    sides ? `The grey band covers ${sides} of the canvas.` : "",
    "Outpaint it: continue the photograph outwards into the grey so the whole canvas becomes one seamless image.",
    "Match the perspective, horizon, lighting, colour, depth of field and grain of the existing photo.",
    "Leave everything inside the photo exactly as it is - do not restyle, move, rescale or re-render it, and do not add new subjects.",
    "Return the complete canvas with no grey remaining.",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The AI preferences. One set for the whole workspace, not one per tab. */
export type AiSettings = { model: string; aspect: string; size: string; count: number };

/** What the workspace needs to know about a tab to name it and to close it. */
export type EditorStatus = { hasImage: boolean; dirty: boolean; name: string | null; choosing: boolean };

/** What the workspace can ask a tab to do. */
export type EditorHandle = {
  /** Save the photo as it looks now. Resolves false if nothing was written. */
  save: () => Promise<boolean>;
};

type EditorProps = {
  /** The tab on screen. Hidden editors keep their state but ignore the keyboard. */
  active: boolean;
  /** Opened once, on mount. null is an empty tab waiting for a photo. */
  file: File | null;
  /** Ask the workspace for its file picker (Open, Ctrl+O, the empty-stage button). */
  onOpen: () => void;
  onStatus: (status: EditorStatus) => void;
  models: ModelInfo[];
  ai: AiSettings;
  setAi: (patch: Partial<AiSettings>) => void;
  ref?: React.Ref<EditorHandle>;
};

/**
 * One photo and everything done to it. The workspace mounts one of these per
 * tab and keeps them all mounted, so switching tabs costs nothing and every
 * tab keeps its history, zoom and open panel.
 */
export default function Editor({ active, file, onOpen, onStatus, models, ai, setAi, ref }: EditorProps) {
  // history of baked PNG object URLs (blob:); index = current state
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const current = index >= 0 ? history[index] : null;

  // Mirrors of the two above. pushState updates them eagerly so two pushes in
  // the same tick (flatten + AI result) do not read a stale history.
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  historyRef.current = history;
  indexRef.current = index;
  // What each history URL actually holds. Bakes are PNG, but a model may hand
  // back JPEG or WebP, and the export should not lie about the extension.
  const typesRef = useRef(new Map<string, string>());

  // What each history state was made by, so the history list can name the steps
  // rather than just number them.
  const labelsRef = useRef(new Map<string, string>());

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [panel, setPanel] = useState<Panel>(null);
  const [transformOpen, setTransformOpen] = useState(false);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [cropAspect, setCropAspect] = useState<number | null>(null); // pixel w/h; null = free
  // Which way a ratio button works: trim the photo down to it, or grow past the
  // photo's edge to reach it. Growing is what leaves space for the AI to fill.
  const [cropMode, setCropMode] = useState<"in" | "out">("in");
  // Transparent border on the current image, i.e. what a crop-out left behind.
  const [emptyArea, setEmptyArea] = useState<Margins | null>(null);

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // non-fatal, e.g. downscaled on open
  const [lastUpload, setLastUpload] = useState<string | null>(null); // what the last AI run sent
  // The last prompt that was sent, and whether it was a plain edit or a fill.
  // Generate clears the box on success, and the commonest next wish is either
  // the same prompt again (the model is not deterministic) or the same prompt
  // with a word changed - so it is kept, for Rerun and Restore.
  const [lastRun, setLastRun] = useState<{ text: string; mode: "edit" | "fill" } | null>(null);
  const [savedUrl, setSavedUrl] = useState<string | null>(null); // last opened/saved image
  const savedUrlRef = useRef<string | null>(null);
  savedUrlRef.current = savedUrl;
  const [sourceName, setSourceName] = useState<string | null>(null); // file the photo came from
  const [lastSave, setLastSave] = useState<{ method: "picker" | "download"; name: string } | null>(null);
  // Whether this browser can offer a real Save As dialog. Read once on the
  // client: touching window during render would differ from the server pass.
  const [canPick, setCanPick] = useState(false);
  useEffect(() => setCanPick(canPickSaveLocation()), []);

  // AI settings live in the workspace, shared by every tab. Read here under
  // the names the rest of the editor grew up with.
  const { model: aiModel, aspect: aiAspect, size: aiSize, count: aiCount } = ai;
  const provider = providerOf(aiModel);
  // Aspect and size mean different things to the two providers (a ratio and a
  // resolution tier for Google, a fixed size and a quality tier for OpenAI),
  // so crossing over resets them rather than carrying a value the other side
  // would misread.
  const setAiModel = (model: string) =>
    setAi(providerOf(model) === provider ? { model } : { model, aspect: "", size: "" });
  const setAiAspect = (aspect: string) => setAi({ aspect });
  const setAiSize = (size: string) => setAi({ size });
  const setAiCount = (count: number) => setAi({ count });

  // Results waiting to be judged. More than one and nothing is committed until
  // the person picks; a single result goes straight into the history as before.
  const [candidates, setCandidates] = useState<{ url: string; mime: string }[] | null>(null);
  const [pick, setPick] = useState(0); // 0 = the photo you started from, 1..n = a result
  const candidateLabel = useRef("");
  const choosing = candidates !== null;
  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  // auto-focus the prompt when the AI tool is chosen
  useEffect(() => {
    if (panel === "ai") aiInputRef.current?.focus();
  }, [panel]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const stageSizeRef = useRef({ w: 0, h: 0 });
  stageSizeRef.current = stageSize;
  const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  // ---- image + stage sizing -------------------------------------------------
  // The on-screen framing to preserve across history/AI swaps (stage px).
  // Updated only by user zoom/pan and file open — NOT by image swaps — so
  // toggling between different-resolution versions keeps a constant size.
  const frame = useRef<{ cx: number; cy: number; w: number; h: number } | null>(null);

  // What the stage is actually showing. While judging results that is the
  // selected candidate, so every measurement below - sizing, framing, the
  // status bar - reports the picture in front of you rather than the committed
  // one behind it.
  const shown = (candidates && pick > 0 ? candidates[pick - 1].url : null) ?? current;

  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    loadImage(shown).then((el) => {
      if (cancelled) return;
      setImg(el);
      try {
        setEmptyArea(emptyMargins(el));
      } catch {
        setEmptyArea(null);
      }
      if (pendingFit.current) return; // a fresh open fits itself (see below)
      const f = frame.current;
      if (!f) return;
      // fit the new image into the remembered frame, centered on the same point
      const zoom = Math.min(f.w / el.naturalWidth, f.h / el.naturalHeight);
      const w = el.naturalWidth * zoom;
      const h = el.naturalHeight * zoom;
      let x = f.cx - w / 2;
      let y = f.cy - h / 2;

      // A step that changes the photo's shape can put the remembered centre
      // near or past the edge of the stage, and the photo then swaps in mostly
      // off-screen - it reads as having vanished. Deliberate panning is left
      // alone; only a swap that would hide the photo re-centres it.
      const st = stageSizeRef.current;
      if (st.w && st.h) {
        const visible =
          Math.max(0, Math.min(x + w, st.w) - Math.max(x, 0)) *
          Math.max(0, Math.min(y + h, st.h) - Math.max(y, 0));
        if (visible < 0.4 * Math.min(w * h, st.w * st.h)) {
          x = (st.w - w) / 2;
          y = (st.h - h) / 2;
        }
      }

      fromSwap.current = true; // this view change must NOT move the frame
      setView({ zoom, x, y });
    });
    return () => {
      cancelled = true;
    };
  }, [shown]);

  // Remember the current framing whenever the user zooms/pans or fits/opens,
  // but ignore view changes that came from an image swap (guarded above).
  const fromSwap = useRef(false);
  useEffect(() => {
    if (!img) return;
    if (pendingFit.current) return; // nothing worth remembering until it is fitted
    if (fromSwap.current) {
      fromSwap.current = false;
      return;
    }
    frame.current = {
      cx: view.x + (img.naturalWidth * view.zoom) / 2,
      cy: view.y + (img.naturalHeight * view.zoom) / 2,
      w: img.naturalWidth * view.zoom,
      h: img.naturalHeight * view.zoom,
    };
  }, [view, img]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [current]);

  const fitToScreen = useCallback(
    (image = img, size = stageSize) => {
      if (!image || !size.w || !size.h) return;
      const pad = 48;
      const zoom = Math.min((size.w - pad) / image.naturalWidth, (size.h - pad) / image.naturalHeight);
      setView({
        zoom,
        x: (size.w - image.naturalWidth * zoom) / 2,
        y: (size.h - image.naturalHeight * zoom) / 2,
      });
    },
    [img, stageSize]
  );

  // Fit to screen only when a new file is opened — NOT on history navigation
  // (undo/redo/toggle keep the current zoom + pan so you stay in the same spot).
  const pendingFit = useRef(true);
  useEffect(() => {
    if (img && stageSize.w && pendingFit.current) {
      pendingFit.current = false;
      fitToScreen(img, stageSize);
    }
  }, [img, stageSize, fitToScreen]);

  // ---- history --------------------------------------------------------------
  // Adds a state, drops any redo branch it replaces, and keeps the depth capped.
  // Every URL that falls out is revoked so the blob behind it is freed - without
  // this, editing a large photo grows the tab's memory until it dies.
  const pushState = useCallback((url: string, label: string, mime = "image/png") => {
    typesRef.current.set(url, mime);
    labelsRef.current.set(url, label);
    const h = historyRef.current;
    const kept = [...h.slice(0, indexRef.current + 1), url];
    const dropped = h.slice(indexRef.current + 1); // redo branch this edit replaces
    const over = Math.max(0, kept.length - MAX_HISTORY);
    if (over) {
      dropped.push(...kept.slice(0, over));
      togglePair.current = null; // stored indices no longer line up
    }
    for (const u of dropped) {
      if (u === savedUrlRef.current) continue;
      revoke(u);
      typesRef.current.delete(u);
      labelsRef.current.delete(u);
    }

    const next = over ? kept.slice(over) : kept;
    historyRef.current = next;
    indexRef.current = next.length - 1;
    setHistory(next);
    setIndex(next.length - 1);
    setAdjust(NEUTRAL_ADJUSTMENTS);
  }, []);

  const openFile = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    setLastUpload(null);
    try {
      const { url, img: el, scaledFrom } = await openImageFile(file);
      for (const u of historyRef.current) revoke(u); // release the previous photo
      typesRef.current.clear();
      labelsRef.current.clear();
      labelsRef.current.set(url, "Original");
      // A downscale on open re-encodes to PNG; otherwise it is the file itself.
      typesRef.current.set(url, scaledFrom ? "image/png" : file.type || "image/png");
      pendingFit.current = true; // fit the newly opened image
      togglePair.current = null;
      historyRef.current = [url];
      indexRef.current = 0;
      setHistory([url]);
      setIndex(0);
      // Deliberately NOT setImg(el) here. The effect on `current` owns loading,
      // and doing it in both places raced: whichever finished second re-anchored
      // the view from a frame recorded before the first fit, which pinned the
      // photo to the top-left corner of the stage from then on.
      setAdjust(NEUTRAL_ADJUSTMENTS);
      setSavedUrl(url); // freshly opened = clean
      setSourceName(file.name || null);
      setLastSave(null);
      setPanel("adjust");
      if (scaledFrom) {
        setNotice(
          `${scaledFrom.w} × ${scaledFrom.h} px is past what this browser can hold on a canvas - ` +
            `editing a ${el.naturalWidth} × ${el.naturalHeight} px copy.`
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open image.");
    }
  }, []);

  // The tab's photo is decided when the tab is made, so it opens once.
  useEffect(() => {
    if (file) void openFile(file);
  }, [file, openFile]);

  // A closed tab takes its blobs with it. Nothing else revokes them: the
  // history only frees what falls out of it, and a whole history at once
  // is what closing a tab drops.
  const candidatesRef = useRef<{ url: string }[] | null>(null);
  candidatesRef.current = candidates;
  useEffect(
    () => () => {
      for (const u of historyRef.current) revoke(u);
      for (const c of candidatesRef.current ?? []) revoke(c.url);
    },
    []
  );

  const flatten = useCallback(async (): Promise<HTMLImageElement> => {
    if (!img) throw new Error("No image.");
    const dirty = adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS);
    if (!dirty) return img;
    const baked = await bakeToUrl(img, { rotate: 0, flipH: false, flipV: false }, adjust, null);
    const el = await loadImage(baked);
    pushState(baked, "Adjustments");
    return el;
  }, [img, adjust, pushState]);

  const applyTransform = useCallback(
    async (rotate: number, flipH = false, flipV = false) => {
      if (!img) return;
      try {
        const what = flipH ? "Flip horizontal" : flipV ? "Flip vertical" : `Rotate ${rotate}°`;
        pushState(await bakeToUrl(img, { rotate, flipH, flipV }, adjust, null), what);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not apply the transform.");
      }
    },
    [img, adjust, pushState]
  );

  const applyCrop = useCallback(async () => {
    if (!img) return;
    const grew = crop.x < -0.001 || crop.y < -0.001 || crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001;
    try {
      pushState(
        await bakeToUrl(img, { rotate: 0, flipH: false, flipV: false }, adjust, crop),
        grew ? "Crop out" : "Crop"
      );
      setCrop(FULL_CROP);
      // A crop-out leaves a hole on purpose; hand straight over to the tool that
      // fills it rather than closing the panel and leaving the user to find it.
      setPanel(grew ? "ai" : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the crop.");
    }
  }, [img, adjust, crop, pushState]);

  // Locked crop ratio expressed in normalized (w/h) units for the overlay.
  const cropNormRatio = cropAspect && img ? cropAspect * (img.naturalHeight / img.naturalWidth) : null;
  const chooseCropAspect = useCallback(
    (px: number | null, mode = cropMode) => {
      setCropAspect(px);
      if (px && img) {
        const nr = px * (img.naturalHeight / img.naturalWidth);
        setCrop((c) => fitCropRatio(c, nr, mode));
      }
    },
    [img, cropMode]
  );

  // Switching direction re-applies the locked ratio the other way round, so the
  // toggle does something visible instead of only affecting the next click.
  const chooseCropMode = useCallback(
    (mode: "in" | "out") => {
      setCropMode(mode);
      if (cropAspect && img) {
        const nr = cropAspect * (img.naturalHeight / img.naturalWidth);
        setCrop((c) => fitCropRatio(c, nr, mode));
      }
    },
    [cropAspect, img]
  );

  // Grow the box past the photo by a fixed amount. Dragging a handle outwards
  // works, but it needs somewhere to drag to; these always work.
  const expandCrop = useCallback((factor: number) => setCrop((c) => scaleCrop(c, factor)), []);

  // Pixel size the current crop would produce, for the panel and the overlay badge.
  const cropOut = useMemo(() => {
    if (!img) return { w: 0, h: 0 };
    return {
      w: Math.max(1, Math.round(crop.w * img.naturalWidth)),
      h: Math.max(1, Math.round(crop.h * img.naturalHeight)),
    };
  }, [img, crop]);
  const cropGrows = crop.x < -0.001 || crop.y < -0.001 || crop.x + crop.w > 1.001 || crop.y + crop.h > 1.001;

  // Opening Crop pulls the view back so the photo sits in about half the stage.
  // Fit-to-screen leaves 24 px of margin, and a handle dragged into that lands
  // outside the stage, which clips it - crop-out was unreachable by dragging.
  useEffect(() => {
    if (panel !== "crop" || !img || !stageSize.w || !stageSize.h) return;
    const room = Math.min(
      (stageSize.w * 0.55) / img.naturalWidth,
      (stageSize.h * 0.55) / img.naturalHeight
    );
    setView((v) =>
      v.zoom <= room
        ? v
        : {
            zoom: room,
            x: (stageSize.w - img.naturalWidth * room) / 2,
            y: (stageSize.h - img.naturalHeight * room) / 2,
          }
    );
  }, [panel, img, stageSize.w, stageSize.h]);

  const runAI = useCallback(
    async (mode: "edit" | "fill" = "edit", text = aiPrompt) => {
      const extra = text.trim();
      if (!img || (mode === "edit" && !extra)) return;
      setError(null);
      setAiBusy(true);
      setLastRun({ text: extra, mode }); // remembered even if the run fails, so it can be retried
      try {
        const flat = await flatten();
        const margins = emptyMargins(flat);

        // Empty space is painted flat grey on the way out. Alpha survives the
        // WebP encode but not the trip through the model, and a region the model
        // cannot see is a region it will not fill.
        const { blob, width, height } = await encodeForUpload(
          flat,
          AI_MAX_EDGE[aiSize] ?? AI_MAX_EDGE[""],
          undefined,
          margins ? EMPTY_FILL : undefined
        );
        setLastUpload(`${width} × ${height} px · ${formatBytes(blob.size)}`);

        const prompt = mode === "fill" ? fillPrompt(margins, extra) : extra;
        // An outpaint must come back the same shape it went out as, or the model
        // re-frames the canvas and the empty band is still there.
        const aspect = mode === "fill" ? nearestAspect(width, height) : aiAspect;

        // One upload, several asks. The requests run together because they are
        // independent and each one takes tens of seconds - four in sequence
        // would be four times the wait for the same four pictures.
        const runs = Math.min(MAX_VERSIONS, Math.max(1, aiCount));
        const send = async () => {
          const form = new FormData();
          form.append("image", blob, "image.webp");
          form.append("prompt", prompt);
          if (aiModel) form.append("model", aiModel);
          form.append("provider", provider);
          if (aspect) form.append("aspectRatio", aspect);
          if (aiSize) form.append("imageSize", aiSize);

          const res = await fetch("/api/ai-edit", { method: "POST", body: form });
          if (!res.ok) throw new Error(await errorFromResponse(res));
          const out = await res.blob();
          if (out.size === 0) throw new Error("The model returned an empty image.");
          return { url: URL.createObjectURL(out), mime: out.type || "image/png" };
        };

        const settled = await Promise.allSettled(Array.from({ length: runs }, send));
        const got = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        if (!got.length) {
          const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
          throw first?.reason instanceof Error ? first.reason : new Error("AI request failed.");
        }

        const label = mode === "fill" ? "AI: fill empty space" : `AI: ${extra}`;
        setAiPrompt(""); // clear on success; stay on the AI tool for the next edit (Restore brings it back)
        if (got.length < runs) {
          setNotice(`${got.length} of ${runs} versions came back. Showing what arrived.`);
        }

        // One result is not a choice, so it is committed straight away. Several
        // are held out of the history until one is picked - a rejected version
        // should leave no trace to step back through.
        if (got.length === 1) {
          pushState(got[0].url, label, got[0].mime);
        } else {
          candidateLabel.current = label;
          setCandidates(got);
          setPick(1);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "AI request failed.");
      } finally {
        setAiBusy(false);
      }
    },
    [img, aiPrompt, aiModel, provider, aiAspect, aiSize, aiCount, flatten, pushState]
  );

  /** Take the selected version (or keep the original) and let the rest go. */
  const commitPick = useCallback(() => {
    if (!candidates) return;
    const chosen = pick > 0 ? candidates[pick - 1] : null;
    for (const c of candidates) if (c !== chosen) revoke(c.url);
    setCandidates(null);
    setPick(0);
    if (chosen) pushState(chosen.url, candidateLabel.current, chosen.mime);
  }, [candidates, pick, pushState]);

  const discardPicks = useCallback(() => {
    if (!candidates) return;
    for (const c of candidates) revoke(c.url);
    setCandidates(null);
    setPick(0);
  }, [candidates]);

  const doDownload = useCallback(async (): Promise<boolean> => {
    if (choosing) return false; // saving a version you have not accepted yet
    try {
      const flat = await flatten();
      const mime = typesRef.current.get(flat.src) || "image/png";
      const ext = EXT[mime] || "png";
      const result = await saveImageAs(flat.src, exportName(sourceName, ext), mime);
      if (!result) return false; // the user closed the Save dialog; nothing was written

      setLastSave(result);
      setSavedUrl(flat.src); // saving marks the current image clean
      setNotice(
        result.method === "picker"
          ? `Saved as ${result.name}, in the folder you picked.`
          : `Saved as ${result.name} in this browser's Downloads folder (Ctrl+J opens it).`
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export the image.");
      return false;
    }
  }, [choosing, flatten, sourceName]);

  // Unsaved changes = current differs from the last opened/saved image,
  // or there are uncommitted live adjustments.
  const dirty =
    current !== null &&
    (current !== savedUrl ||
      adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS));

  // What the tab strip shows and what closing the tab has to know.
  useEffect(() => {
    onStatus({ hasImage: current !== null, dirty, name: sourceName, choosing });
  }, [onStatus, current, dirty, sourceName, choosing]);

  // Ctrl+Z: A/B toggle between the current state and the previous one
  // (repeated presses flip back and forth to compare the last change).
  const togglePair = useRef<{ a: number; b: number } | null>(null);
  const toggleLast = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    const t = togglePair.current;
    if (t && (index === t.a || index === t.b)) {
      setIndex(index === t.a ? t.b : t.a);
    } else {
      const pair = { a: index, b: Math.max(0, index - 1) };
      togglePair.current = pair;
      setIndex(pair.b);
    }
  }, [index]);

  // "Compare to" borrows the history index rather than drawing a second image,
  // so what you see while comparing is exactly what stepping there would show.
  // compareFrom remembers the seat you got up from.
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const compareTo = useCallback(
    (target: "original" | "previous") => {
      setAdjust(NEUTRAL_ADJUSTMENTS);
      if (compareFrom !== null) {
        setIndex(compareFrom); // second click on either button puts you back
        setCompareFrom(null);
        return;
      }
      const to = target === "original" ? 0 : Math.max(0, indexRef.current - 1);
      if (to === indexRef.current) return;
      setCompareFrom(indexRef.current);
      setIndex(to);
    },
    [compareFrom]
  );
  const endCompare = useCallback(() => {
    setCompareFrom((from) => {
      if (from !== null) setIndex(from);
      return null;
    });
  }, []);

  // Ctrl+Shift+Z: walk backward through the full history, one step per press.
  const stepBack = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    setCompareFrom(null);
    togglePair.current = null;
    setIndex((i) => Math.max(0, i - 1));
  }, []);
  const stepForward = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    setCompareFrom(null);
    togglePair.current = null;
    setIndex((i) => Math.min(history.length - 1, i + 1));
  }, [history.length]);

  // ---- viewport: zoom + pan -------------------------------------------------
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const zoom = Math.min(40, Math.max(0.02, v.zoom * factor));
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  const zoomButton = useCallback(
    (factor: number) => zoomAt(factor, stageSize.w / 2, stageSize.h / 2),
    [zoomAt, stageSize]
  );

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }, []);

  // Hidden tabs keep their state but must not answer the keyboard, or one
  // Ctrl+Z would step every tab back at once.
  const activeRef = useRef(active);
  activeRef.current = active;

  // re-fit the image when entering/exiting fullscreen (stage size changes)
  useEffect(() => {
    const onFs = () => {
      if (activeRef.current) pendingFit.current = true;
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // native wheel listener so we can preventDefault (React onWheel is passive)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, current]);

  // keep latest panel/applyCrop for the (stable) key handler
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const applyCropRef = useRef(applyCrop);
  applyCropRef.current = applyCrop;
  const downloadRef = useRef(doDownload);
  downloadRef.current = doDownload;
  const fitRef = useRef(fitToScreen);
  fitRef.current = fitToScreen;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  // The workspace's close prompt needs to save on the tab's behalf.
  useImperativeHandle(ref, () => ({ save: () => downloadRef.current() }), []);
  const chooseRef = useRef<{
    n: number;
    commit: () => void;
    discard: () => void;
  } | null>(null);
  chooseRef.current = candidates ? { n: candidates.length, commit: commitPick, discard: discardPicks } : null;

  // space-to-pan + shortcuts
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    const down = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      // Judging results takes the keyboard over: the same ← / → that walk the
      // history walk the versions, and nothing else should reach the image
      // while there is an unanswered question on screen.
      const c = chooseRef.current;
      if (c && (e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
        e.preventDefault(); // no stepping the history while a version is pending
        return;
      }
      if (c && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        const k = e.key;
        if (k === "ArrowLeft" || k === "ArrowRight") {
          e.preventDefault();
          setPick((p) => Math.min(c.n, Math.max(0, p + (k === "ArrowRight" ? 1 : -1))));
          return;
        }
        if (/^[0-9]$/.test(k)) {
          e.preventDefault();
          setPick(Math.min(c.n, Number(k)));
          return;
        }
        if (k === "Enter") {
          e.preventDefault();
          c.commit();
          return;
        }
        if (k === "Escape") {
          e.preventDefault();
          c.discard();
          return;
        }
        // Everything else is swallowed. Looking at a version that is not
        // committed yet, a crop or an undo would act on state the picture on
        // screen does not belong to. Fit and fullscreen only move the camera.
        if (!["f", "r", "F", "R"].includes(k)) return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? stepBack() : toggleLast();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        stepForward();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void downloadRef.current(); // save the current image
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        onOpenRef.current(); // open more photos, each in its own tab
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        // single-key tool / panel shortcuts
        const k = e.key.toLowerCase();
        const handled =
          ["c", "a", "v", "escape", "i", "t", "f", "r", "arrowleft", "arrowright"].includes(k) ||
          (e.key === "Enter" && panelRef.current === "crop");
        if (handled) e.preventDefault(); // don't let the key type into a field it may focus
        // ← / → walk the versions. The same step as the History arrows, so the
        // counter in the sidebar is the readout for both.
        if (k === "arrowleft") stepBack();
        else if (k === "arrowright") stepForward();
        else if (k === "c") setPanel((p) => (p === "crop" ? null : "crop"));
        else if (k === "a") setPanel((p) => (p === "ai" ? null : "ai"));
        else if (k === "i") setPanel((p) => (p === "adjust" ? null : "adjust"));
        else if (k === "t") setTransformOpen((v) => !v);
        else if (k === "v" || k === "escape") {
          setPanel(null);
          setTransformOpen(false);
        } else if (k === "f") toggleFullscreen();
        else if (k === "r") fitRef.current();
        else if (e.key === "Enter" && panelRef.current === "crop") applyCropRef.current();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [toggleLast, stepBack, stepForward]);

  // Panning is always available. In crop mode, drags that start on the crop
  // box/handles are captured by the overlay; drags anywhere else pan the view.
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const cx = e.clientX;
    const cy = e.clientY;
    setView((v) => ({ ...v, x: p.vx + (cx - p.x), y: p.vy + (cy - p.y) }));
  };
  const onStagePointerUp = () => {
    pan.current = null;
    setPanning(false);
  };

  const imgBox = useMemo(() => {
    if (!img) return null;
    return { left: view.x, top: view.y, width: img.naturalWidth * view.zoom, height: img.naturalHeight * view.zoom };
  }, [img, view]);

  const filter = adjustmentsToFilter(adjust);
  const cursor = panning ? "grabbing" : panel === "crop" ? "default" : "grab";

  const panelTitle = panel === "crop" ? "Crop" : panel === "adjust" ? "Adjustments" : "AI Edit";
  const adjustDirty = adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS);

  return (
    <div style={{ display: active ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <Sidebar
        hasImage={!!current}
        choosing={choosing}
        history={history}
        step={index}
        onUndo={stepBack}
        onRedo={stepForward}
        canUndo={index > 0}
        canRedo={index < history.length - 1}
        onCompare={compareTo}
        comparing={compareFrom !== null}
        stepLabel={current ? labelsRef.current.get(current) ?? null : null}
        panel={panel}
        onPanel={(p) => setPanel((cur) => (cur === p ? null : p))}
        transformOpen={transformOpen}
        onTransformToggle={() => setTransformOpen((v) => !v)}
        onTransform={(r, fh, fv) => {
          setTransformOpen(false);
          void applyTransform(r, fh, fv);
        }}
        onOpen={onOpen}
        onSave={doDownload}
        dirty={dirty}
        canPick={canPick}
        lastSave={lastSave}
        onZoomIn={() => zoomButton(1.25)}
        onZoomOut={() => zoomButton(1 / 1.25)}
        onFit={() => fitToScreen()}
        onFullscreen={toggleFullscreen}
      />

      {/* CENTER: stage above a status bar */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          ref={stageRef}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          style={{
            position: "relative",
            flex: 1,
            overflow: "hidden",
            cursor,
            background: "repeating-conic-gradient(#141418 0% 25%, #101014 0% 50%) 50% / 24px 24px",
          }}
        >
          {!current && (
            <div style={emptyStage}>
              <div style={{ fontSize: 34, marginBottom: 10 }}>🖼️</div>
              <p style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600 }}>No photo open</p>
              <p style={{ ...hint, margin: "0 0 18px" }}>
                Drop one here, or pick <strong style={{ color: "var(--text)", fontWeight: 600 }}>Open</strong> in the
                menu.
              </p>
              <button
                className="primary"
                onClick={onOpen}
                onPointerDown={(e) => e.stopPropagation()}
                style={{ pointerEvents: "auto" }}
              >
                Choose a photo
              </button>
            </div>
          )}

          {shown && imgBox && (
            <>
              <img
                src={shown}
                alt="editing"
                draggable={false}
                style={{
                  position: "absolute",
                  left: imgBox.left,
                  top: imgBox.top,
                  width: imgBox.width,
                  height: imgBox.height,
                  filter,
                  imageRendering: view.zoom > 3 ? "pixelated" : "auto",
                  boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 12px 40px rgba(0,0,0,0.5)",
                }}
              />
              {panel === "crop" && (
                <CropOverlay
                  imgBox={imgBox}
                  value={crop}
                  onChange={(r) => setCrop(clampCrop(r))}
                  ratio={cropNormRatio}
                  outSize={cropOut}
                />
              )}
            </>
          )}

          {/* Messages float over the stage rather than hiding in the panel,
              which can be closed - an error there could go unseen entirely. */}
          <div style={toastWrap}>
            {compareFrom !== null && (
              <button onClick={endCompare} style={compareBadge} title="Back to where you were">
                Comparing · showing step {index + 1},{" "}
                {(current && labelsRef.current.get(current)) || "an earlier step"} — click to return to step{" "}
                {compareFrom + 1}
              </button>
            )}
            {error && (
              <Toast tone="error" onClose={() => setError(null)}>
                {error}
              </Toast>
            )}
            {notice && (
              <Toast tone="notice" onClose={() => setNotice(null)}>
                {notice}
              </Toast>
            )}
          </div>

          {/* floating AI prompt bar, below the image */}
          {panel === "ai" && !choosing && (
            <div
              style={aiBar}
              // The stage captures the pointer on any pointerdown that reaches
              // it, to pan. Capture retargets the click, so a button inside this
              // bar would never fire one. CropOverlay guards itself the same way.
              onPointerDown={(e) => e.stopPropagation()}
            >
              {aiBusy && (
                <div style={aiBusyOverlay}>
                  <span className="spinner" />
                  <span style={{ fontSize: 12 }}>
                    {aiCount > 1 ? `Generating ${aiCount} versions` : "Generating"} with {aiModel || "model"}…
                  </span>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <textarea
                  ref={aiInputRef}
                  rows={1}
                  placeholder="Describe an edit — e.g. remove the background… (Ctrl+Enter to run)"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      void runAI();
                    }
                  }}
                  style={{ flex: 1, minHeight: 40, maxHeight: 120, background: "var(--panel-2)" }}
                  disabled={aiBusy}
                />
                <button
                  className="primary"
                  onClick={() => void runAI()}
                  disabled={aiBusy || !aiPrompt.trim()}
                  style={{ height: 40 }}
                  title="Ctrl+Enter"
                >
                  {aiBusy ? "…" : "Generate"}
                </button>
              </div>

              {/* The last prompt, twice over: once to send it again as it was,
                  once to get it back into the box to change. Only shown once
                  there is one, so the bar starts as plain as before. */}
              {lastRun && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, minWidth: 0 }}>
                  <button
                    onClick={() => void runAI(lastRun.mode, lastRun.text)}
                    disabled={aiBusy}
                    style={rerunBtn}
                    title={
                      lastRun.mode === "fill"
                        ? "Run Fill empty space again with the same prompt"
                        : "Send the same prompt again - the model gives a different result each time"
                    }
                  >
                    ↻ Rerun
                  </button>
                  <button
                    onClick={() => {
                      setAiPrompt(lastRun.text);
                      aiInputRef.current?.focus();
                    }}
                    disabled={aiBusy || aiPrompt === lastRun.text}
                    style={rerunBtn}
                    title="Put the last prompt back in the box, to change it"
                  >
                    ↶ Restore
                  </button>
                  <span style={{ ...hint, fontSize: 11, ...ellipsis }} title={lastRun.text || "Fill empty space"}>
                    {lastRun.mode === "fill" ? "Fill empty space" : ""}
                    {lastRun.mode === "fill" && lastRun.text ? " + " : ""}
                    {lastRun.text && <em style={{ color: "var(--text)", fontStyle: "normal" }}>“{lastRun.text}”</em>}
                  </span>
                </div>
              )}

              {/* Only offered when there is actually empty space to fill, so the
                  button is never a promise the image cannot keep. */}
              {emptyArea && (
                <button
                  onClick={() => void runAI("fill")}
                  disabled={aiBusy}
                  style={fillButton}
                  title="Extend the photo into the empty area left by a crop-out"
                >
                  ✨ Fill empty space
                  <span style={{ opacity: 0.75, fontWeight: 400 }}>
                    — extend the photo into the area the crop added
                  </span>
                </button>
              )}

              {/* How many to ask for. Kept beside Generate rather than buried in
                  the settings panel, because it multiplies what a click costs. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <span style={{ ...label, color: "var(--muted)" }}>Versions</span>
                <div style={segmented}>
                  {Array.from({ length: MAX_VERSIONS }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      onClick={() => setAiCount(n)}
                      disabled={aiBusy}
                      aria-pressed={aiCount === n}
                      title={n === 1 ? "One result, applied straight away" : `${n} results to choose between`}
                      style={{
                        ...segment,
                        background: aiCount === n ? "var(--accent)" : "transparent",
                        color: aiCount === n ? "#fff" : "var(--muted)",
                        fontWeight: aiCount === n ? 700 : 500,
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span style={{ ...hint, fontSize: 11 }}>
                  {aiCount === 1 ? "applied straight away" : "you pick one afterwards"}
                </span>
                <span style={{ ...hint, fontSize: 11, marginLeft: "auto" }}>
                  {lastUpload ? `Sent ${lastUpload}` : `Sends a copy at up to ${AI_MAX_EDGE[aiSize] ?? AI_MAX_EDGE[""]} px`}
                </span>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
                {["Remove background", "Black & white film", "Enhance & sharpen", "Golden-hour light"].map((p) => (
                  <button
                    key={p}
                    style={{ fontSize: 11, padding: "4px 8px" }}
                    onClick={() => setAiPrompt(p)}
                    disabled={aiBusy}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* The chooser. Takes the AI bar's place so there is one thing to
              answer, and lives outside the panel check so closing the panel
              cannot orphan four unjudged results. */}
          {candidates && (
            <div style={aiBar} onPointerDown={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {candidates.length} versions came back - pick the one you want
                </span>
                <span style={{ ...hint, fontSize: 11, marginLeft: "auto" }}>
                  ← → to step, Enter to keep, Esc to discard
                </span>
              </div>

              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
                {[{ url: current, name: "Original" }, ...candidates.map((c, i) => ({ url: c.url, name: `${i + 1}` }))].map(
                  (t, i) => (
                    <button
                      key={t.url ?? i}
                      onClick={() => setPick(i)}
                      aria-pressed={pick === i}
                      title={i === 0 ? "The photo you started from" : `Version ${i}`}
                      style={{
                        ...thumbBtn,
                        borderColor: pick === i ? "var(--accent)" : "var(--border)",
                        boxShadow: pick === i ? "0 0 0 2px rgba(76,141,255,0.35)" : "none",
                      }}
                    >
                      {t.url && <img src={t.url} alt={t.name} style={thumbImg} draggable={false} />}
                      <span style={{ ...thumbLabel, color: pick === i ? "var(--text)" : "var(--muted)" }}>{t.name}</span>
                    </button>
                  )
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <span style={{ ...hint, fontSize: 11 }}>
                  {pick === 0
                    ? "Showing the photo you started from"
                    : `Showing version ${pick} of ${candidates.length}`}
                </span>
                <button onClick={discardPicks} style={{ marginLeft: "auto" }}>
                  Discard all
                </button>
                <button className="primary" onClick={commitPick}>
                  {pick === 0 ? "Keep the original" : `Use version ${pick}`}
                </button>
              </div>
            </div>
          )}
        </div>

        <StatusBar img={img} zoom={view.zoom} />
      </div>

      {/* RIGHT: whatever the selected sidebar entry needs */}
      {current && panel && (
        <aside style={sidePanel}>
          <div style={panelHeader}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {panelTitle}
            </span>
            <button onClick={() => setPanel(null)} style={iconBtn} title="Close panel (Esc)">
              ×
            </button>
          </div>

          {panel === "crop" && (
            <div style={panelBody}>
              <div style={{ display: "grid", gap: 5 }}>
                <span style={label}>Direction</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {(
                    [
                      ["in", "Crop in", "Trim the photo down"],
                      ["out", "Crop out", "Add empty space around it"],
                    ] as const
                  ).map(([mode, lbl, tip]) => (
                    <button
                      key={mode}
                      title={tip}
                      onClick={() => chooseCropMode(mode)}
                      style={{
                        flex: 1,
                        fontSize: 12,
                        padding: "7px 4px",
                        background: cropMode === mode ? "var(--accent)" : undefined,
                        borderColor: cropMode === mode ? "var(--accent)" : undefined,
                        color: cropMode === mode ? "#fff" : undefined,
                      }}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gap: 5 }}>
                <span style={label}>Ratio</span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                  {CROP_RATIOS.map(([lbl, r]) => {
                    const active = cropAspect === r || (r === null && cropAspect === null);
                    return (
                      <button
                        key={lbl}
                        onClick={() => chooseCropAspect(r)}
                        style={{
                          fontSize: 11,
                          padding: "6px 4px",
                          background: active ? "var(--accent)" : undefined,
                          borderColor: active ? "var(--accent)" : undefined,
                          color: active ? "#fff" : undefined,
                        }}
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: "grid", gap: 5 }}>
                <span style={label}>Add space all round</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {[0.1, 0.25, 0.5].map((f) => (
                    <button key={f} style={{ flex: 1, fontSize: 11, padding: "6px 4px" }} onClick={() => expandCrop(f)}>
                      +{Math.round(f * 100)}%
                    </button>
                  ))}
                  <button
                    style={{ flex: 1, fontSize: 11, padding: "6px 4px" }}
                    onClick={() => expandCrop(-0.2)}
                    title="Pull the box back in"
                  >
                    −20%
                  </button>
                </div>
              </div>

              <div style={cropReadout}>
                <span>Result</span>
                <strong style={{ fontVariantNumeric: "tabular-nums" }}>
                  {cropOut.w} × {cropOut.h} px
                </strong>
              </div>
              <p style={hint}>
                {cropGrows
                  ? "The new area is empty. Apply the crop, then open AI Edit and use Fill empty space to paint it in."
                  : "Drag the handles on the photo, or use the buttons above. Crop out adds empty space the AI can fill."}
              </p>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  style={{ flex: 1 }}
                  onClick={() => {
                    setCrop(FULL_CROP);
                    setCropAspect(null);
                  }}
                >
                  Reset
                </button>
                <button className="primary" style={{ flex: 1 }} onClick={applyCrop} title="Enter">
                  Apply crop
                </button>
              </div>
            </div>
          )}

          {panel === "adjust" && (
            <div style={panelBody}>
              {SLIDERS.map(([key, lbl, min, max]) => (
                <div key={key} style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={label}>{lbl}</span>
                    <button
                      onClick={() => setAdjust({ ...adjust, [key]: NEUTRAL_ADJUSTMENTS[key] })}
                      title="Reset this one"
                      style={{
                        ...valueBtn,
                        color: adjust[key] === NEUTRAL_ADJUSTMENTS[key] ? "var(--muted)" : "var(--text)",
                      }}
                    >
                      {adjust[key]}
                    </button>
                  </div>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    value={adjust[key]}
                    onChange={(e) => setAdjust({ ...adjust, [key]: Number(e.target.value) })}
                    onPointerUp={() => void flatten()}
                    onKeyUp={() => void flatten()}
                    onTouchEnd={() => void flatten()}
                  />
                </div>
              ))}
              <button onClick={() => setAdjust(NEUTRAL_ADJUSTMENTS)} disabled={!adjustDirty}>
                Reset all
              </button>
              <p style={hint}>Adjustments apply when you let go of a slider. Ctrl+Z steps back.</p>
            </div>
          )}

          {panel === "ai" && (
            <div style={panelBody}>
              <Field label="Model" hint="Every image model the configured keys can reach. The choice is remembered.">
                <Select
                  value={aiModel}
                  onChange={setAiModel}
                  options={models.map((m) => ({ value: m.id, label: `${PROVIDER_NAME[m.provider]} · ${m.id}` }))}
                  placeholder={models.length ? "Pick a model" : "Loading…"}
                />
              </Field>
              {provider === "openai" ? (
                <>
                  <Field label="Output size" hint="OpenAI works at one of three fixed sizes. Match input picks the nearest.">
                    <Select value={aiAspect} onChange={setAiAspect} options={OPENAI_ASPECTS} />
                  </Field>
                  <Field label="Quality" hint="Higher is slower and costs more per image.">
                    <Select value={aiSize} onChange={setAiSize} options={OPENAI_QUALITIES} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Aspect ratio">
                    <Select
                      value={aiAspect}
                      onChange={setAiAspect}
                      options={[
                        { value: "", label: "Match input" },
                        ...GOOGLE_ASPECTS.map((r) => ({ value: r, label: r })),
                      ]}
                    />
                  </Field>
                  <Field
                    label="Resolution"
                    hint={`Also sets how large a copy is uploaded: up to ${AI_MAX_EDGE[aiSize] ?? AI_MAX_EDGE[""]} px on the long edge.`}
                  >
                    <Select
                      value={aiSize}
                      onChange={setAiSize}
                      options={[
                        { value: "", label: "Model default" },
                        ...GOOGLE_SIZES.map((s) => ({ value: s, label: s })),
                      ]}
                    />
                  </Field>
                </>
              )}
              <p style={hint}>Type the edit in the bar over the photo, then Ctrl+Enter.</p>
              {emptyArea && (
                <p style={{ ...hint, color: "var(--text)" }}>
                  This photo has empty space around it. Use <strong>Fill empty space</strong> in the bar over the
                  photo to have the model extend the picture into it.
                </p>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/* =========================== sub-views =========================== */

// Unicode glyphs (⤓ ▢ ⟳ ⛶) come from whatever font happens to have them, so
// they land at different weights, sizes and baselines next to each other. These
// are one stroke weight on one grid, and they take the row's colour.
const ICONS: Record<string, React.ReactNode> = {
  open: <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  save: (
    <>
      <path d="M12 3v11" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </>
  ),
  transform: (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </>
  ),
  adjust: (
    <>
      <path d="M21 5h-7M10 5H3M21 12h-9M8 12H3M21 19h-5M12 19H3" />
      <path d="M14 3v4M8 10v4M16 17v4" />
    </>
  ),
  ai: (
    <>
      <path d="M11 3.5 12.7 8l4.5 1.7-4.5 1.8L11 16l-1.7-4.5L4.8 9.7 9.3 8z" />
      <path d="m18 14.5.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.2-4.2M8.2 11h5.6M11 8.2v5.6" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.2-4.2M8.2 11h5.6" />
    </>
  ),
  fit: <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />,
  fullscreen: <path d="M15 3h6v6M21 3l-7.5 7.5M9 21H3v-6M3 21l7.5-7.5" />,
};

function Icon({ name }: { name: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {ICONS[name]}
    </svg>
  );
}

const SLIDERS: [keyof Adjustments, string, number, number][] = [
  ["brightness", "Brightness", 0, 200],
  ["contrast", "Contrast", 0, 200],
  ["saturation", "Saturation", 0, 200],
  ["sepia", "Warmth", 0, 100],
  ["grayscale", "Grayscale", 0, 100],
];

/**
 * The single home for every control. An entry either runs an action, opens a
 * popup next to itself, or opens its controls in the side panel - which kind it
 * is, is visible before you click it: panel entries carry a chevron and light
 * up while open, popup entries carry a caret.
 */
function Sidebar(props: {
  hasImage: boolean;
  history: string[];
  step: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onCompare: (target: "original" | "previous") => void;
  comparing: boolean;
  stepLabel: string | null; // what made the version you are looking at
  panel: Panel;
  onPanel: (p: Panel) => void;
  transformOpen: boolean;
  onTransformToggle: () => void;
  onTransform: (rotate: number, flipH?: boolean, flipV?: boolean) => void;
  onOpen: () => void;
  onSave: () => void;
  dirty: boolean;
  canPick: boolean;
  lastSave: { method: "picker" | "download"; name: string } | null;
  // While unjudged AI results are on screen, everything that would edit or
  // replace the photo underneath them is out of reach until one is chosen.
  choosing: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onFullscreen: () => void;
}) {
  // The sidebar scrolls, which clips anything drawn outside it, so the popup is
  // positioned in the viewport from the entry's own box instead of beside it.
  const transformRef = useRef<HTMLDivElement>(null);
  const [popupAt, setPopupAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!props.transformOpen) return setPopupAt(null);
    const r = transformRef.current?.getBoundingClientRect();
    if (r) setPopupAt({ left: r.right + 8, top: r.top - 6 });
  }, [props.transformOpen]);

  return (
    <nav style={sidebar}>
      <div style={brand}>
        Photo<span style={{ color: "var(--accent)" }}>AI</span>
      </div>

      <GroupLabel>File</GroupLabel>
      <Entry icon="open" label="Open" keyHint="Ctrl+O" onClick={props.onOpen} disabled={props.choosing} />
      <Entry
        icon="save"
        label={props.canPick ? "Save as…" : "Save"}
        keyHint="Ctrl+S"
        onClick={props.onSave}
        dot={props.dirty}
        disabled={!props.hasImage || props.choosing}
      />
      {/* Where the file goes, said before and after the fact - the commonest
          way to lose an edited photo is never being told where it landed. */}
      <div style={saveWhere}>
        {props.lastSave ? (
          <>
            Last saved <strong style={{ color: "var(--text)", fontWeight: 600 }}>{props.lastSave.name}</strong>
            {props.lastSave.method === "download" ? " to your Downloads folder" : " where you chose"}
          </>
        ) : props.canPick ? (
          "Save asks you which folder to put it in."
        ) : (
          "Saves into this browser's Downloads folder."
        )}
      </div>

      <GroupLabel>Edit</GroupLabel>
      <Entry
        icon="crop"
        label="Crop"
        disabled={!props.hasImage || props.choosing}
        keyHint="C"
        kind="panel"
        active={props.panel === "crop"}
        onClick={() => props.onPanel("crop")}
      />
      <div ref={transformRef}>
        <Entry
          icon="transform"
          label="Transform"
          disabled={!props.hasImage || props.choosing}
          keyHint="T"
          kind="popup"
          active={props.transformOpen}
          onClick={props.onTransformToggle}
        />
        {props.transformOpen && popupAt && (
          <>
            <div style={popupCatcher} onClick={props.onTransformToggle} />
            <div style={{ ...popup, left: popupAt.left, top: popupAt.top }}>
              <span style={{ ...label, color: "var(--muted)" }}>Rotate</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={{ flex: 1 }} onClick={() => props.onTransform(90)}>⟳ 90°</button>
                <button style={{ flex: 1 }} onClick={() => props.onTransform(-90)}>⟲ 90°</button>
                <button style={{ flex: 1 }} onClick={() => props.onTransform(180)}>180°</button>
              </div>
              <span style={{ ...label, color: "var(--muted)", marginTop: 4 }}>Flip</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={{ flex: 1 }} onClick={() => props.onTransform(0, true, false)}>⇋ Horizontal</button>
                <button style={{ flex: 1 }} onClick={() => props.onTransform(0, false, true)}>⇅ Vertical</button>
              </div>
            </div>
          </>
        )}
      </div>
      <Entry
        icon="adjust"
        label="Adjustments"
        disabled={!props.hasImage || props.choosing}
        keyHint="I"
        kind="panel"
        active={props.panel === "adjust"}
        onClick={() => props.onPanel("adjust")}
      />
      <Entry
        icon="ai"
        label="AI Edit"
        disabled={!props.hasImage || props.choosing}
        keyHint="A"
        kind="panel"
        active={props.panel === "ai"}
        onClick={() => props.onPanel("ai")}
      />

      <GroupLabel>View</GroupLabel>
      <Entry icon="zoomIn" label="Zoom in" onClick={props.onZoomIn} disabled={!props.hasImage} />
      <Entry icon="zoomOut" label="Zoom out" onClick={props.onZoomOut} disabled={!props.hasImage} />
      <Entry icon="fit" label="Fit to window" keyHint="R" onClick={props.onFit} disabled={!props.hasImage} />
      <Entry icon="fullscreen" label="Fullscreen" keyHint="F" onClick={props.onFullscreen} disabled={!props.hasImage} />

      <p style={{ ...hint, fontSize: 11, padding: "14px 14px 0" }}>Drag to pan · scroll to zoom</p>

      <div style={{ flex: 1, minHeight: 12 }} />

      <div style={historyWrap}>
        <div style={{ ...groupLabel, padding: "10px 14px 6px" }}>History</div>

        <div style={stepRow}>
          <Tip tip={TIPS.back}>
            <button
              onClick={props.onUndo}
              disabled={!props.canUndo || props.choosing}
              aria-label="Previous version"
              style={stepArrow}
            >
              ◀
            </button>
          </Tip>
          <span style={stepCount}>
            {props.history.length ? `${props.step + 1} / ${props.history.length}` : "-"}
          </span>
          <Tip tip={TIPS.forward}>
            <button
              onClick={props.onRedo}
              disabled={!props.canRedo || props.choosing}
              aria-label="Next version"
              style={stepArrow}
            >
              ▶
            </button>
          </Tip>
        </div>
        <div style={{ ...saveWhere, padding: "4px 14px 0", textAlign: "center" }}>
          {props.choosing
            ? "Pick one of the new versions below the photo"
            : props.stepLabel || "Use ← and → to step through versions"}
        </div>

        <div style={{ ...groupLabel, padding: "10px 14px 6px", opacity: 0.6 }}>Compare to</div>
        <div style={{ display: "flex", gap: 6, padding: "0 12px 12px" }}>
          <Tip tip={TIPS.original} grow>
            <button
              onClick={() => props.onCompare("original")}
              disabled={(!props.canUndo && !props.comparing) || props.choosing}
              style={{ ...miniBtn, width: "100%", ...(props.comparing ? comparingBtn : null) }}
            >
              Original
            </button>
          </Tip>
          <Tip tip={TIPS.previous} grow>
            <button
              onClick={() => props.onCompare("previous")}
              disabled={(!props.canUndo && !props.comparing) || props.choosing}
              style={{ ...miniBtn, width: "100%", ...(props.comparing ? comparingBtn : null) }}
            >
              Last change
            </button>
          </Tip>
        </div>
      </div>
    </nav>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div style={groupLabel}>{children}</div>;
}

/* --------------------------- tooltips --------------------------- */

/**
 * What every control in the menu says about itself. Each one answers the two
 * questions a native title= attribute never does: what is this for, and what do
 * I actually do with it. Kept as data next to the sidebar so a new entry
 * without an explanation is obvious at a glance.
 */
type TipText = { title: string; body: string; keys?: string };

const TIPS: Record<string, TipText> = {
  open: {
    title: "Open a photo",
    body: "Pick a picture from this computer to work on. You can also drag a file straight onto the photo area.",
    keys: "Ctrl+O",
  },
  save: {
    title: "Save the photo",
    body:
      "Writes the picture exactly as it looks now. Your browser asks which folder to put it in, and the menu then shows the name it was saved under.",
    keys: "Ctrl+S",
  },
  crop: {
    title: "Crop",
    body:
      "Trim the photo down, or switch to Crop out to add empty space around it. Drag the corner handles, or use the ratio and +% buttons, then Apply crop.",
    keys: "C",
  },
  transform: {
    title: "Rotate and flip",
    body: "Turn the photo in 90° steps or mirror it. Each click is applied straight away and can be stepped back with ←.",
    keys: "T",
  },
  adjust: {
    title: "Colour and light",
    body:
      "Brightness, contrast, saturation, warmth and grayscale. Drag a slider to preview; letting go of it saves that as a version.",
    keys: "I",
  },
  ai: {
    title: "AI edit",
    body:
      "Describe a change in plain words and the image model redraws the photo. Ask for up to four versions and you pick the one you like; ask for one and it is applied straight away. Fill empty space lives here too.",
    keys: "A",
  },
  zoomIn: { title: "Zoom in", body: "Look closer at the photo. Scrolling the wheel over it does the same, centred on the pointer." },
  zoomOut: { title: "Zoom out", body: "Pull back from the photo. Useful before a crop-out, to leave room to drag the handles outwards." },
  fit: { title: "Fit to window", body: "Puts the whole photo back on screen at a size that fits. Undoes any zooming and panning.", keys: "R" },
  fullscreen: { title: "Fullscreen", body: "Gives the photo the whole screen, with the menu hidden. Press F or Esc to come back.", keys: "F" },
  back: { title: "Previous version", body: "Steps one change back. The counter shows which version you are on, and the line under it what made it.", keys: "←" },
  forward: { title: "Next version", body: "Steps forward again, towards the newest version.", keys: "→" },
  original: {
    title: "Compare with the original",
    body: "Jumps to the photo as it was opened, so you can see how far you have come. Click again to return to where you were.",
  },
  previous: {
    title: "Compare with the step before",
    body: "Shows what the last change actually did. Click again to return to where you were.",
  },
};

/**
 * Hover help anchored beside whatever it wraps.
 * Fixed rather than absolute because the sidebar scrolls and clips, top-aligned
 * with the row (and bottom-aligned near the foot of the window) so the card
 * never needs its own height measured before it can be placed.
 */
function Tip({ tip, grow, children }: { tip?: TipText; grow?: boolean; children: React.ReactNode }) {
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const open = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = wrap.current?.getBoundingClientRect();
      if (!r) return;
      const nearBottom = r.top > window.innerHeight - 190;
      setAt({
        left: r.right + 10,
        ...(nearBottom ? { bottom: window.innerHeight - r.bottom - 6 } : { top: r.top - 6 }),
      });
    }, 260); // long enough that sweeping past the menu stays quiet
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setAt(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (!tip) return <>{children}</>;

  return (
    <div
      ref={wrap}
      style={{ position: "relative", flex: grow ? 1 : undefined, minWidth: 0 }}
      onPointerEnter={open}
      onPointerLeave={close}
      onPointerDown={close}
      onFocusCapture={open}
      onBlurCapture={close}
    >
      {children}
      {at && (
        <div className="tip" style={{ ...tipCard, left: at.left, top: at.top, bottom: at.bottom }} role="tooltip">
          <div style={{ ...tipArrow, ...(at.bottom !== undefined ? { bottom: 16 } : { top: 16 }) }} />
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1 }}>{tip.title}</span>
            {tip.keys && <span style={{ ...kbd, opacity: 1 }}>{tip.keys}</span>}
          </div>
          <p style={{ margin: "5px 0 0", fontSize: 11.5, lineHeight: 1.55, color: "var(--muted)" }}>{tip.body}</p>
        </div>
      )}
    </div>
  );
}

function Entry(props: {
  icon: string;
  label: string;
  keyHint?: string;
  kind?: "panel" | "popup";
  active?: boolean;
  dot?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { active } = props;
  return (
    // The tip is keyed off the icon name, which is also what identifies the
    // entry - so an entry can never quietly end up with another one's help.
    <Tip tip={TIPS[props.icon]}>
      <button
        onClick={props.onClick}
        disabled={props.disabled}
        aria-label={props.label}
        aria-pressed={props.kind ? !!active : undefined}
        style={{
          ...entry,
          background: active ? "rgba(76,141,255,0.14)" : "transparent",
          color: active ? "var(--text)" : "var(--muted)",
          boxShadow: active ? "inset 2px 0 0 var(--accent)" : "none",
        }}
      >
        <span style={{ color: active ? "var(--accent)" : "inherit" }}>
          <Icon name={props.icon} />
        </span>
        <span style={{ flex: 1, textAlign: "left" }}>
          {props.label}
          {props.dot && <span style={unsavedDot} aria-label="Unsaved changes" />}
        </span>
        {props.kind === "popup" && <span style={entryMark}>▾</span>}
        {props.keyHint && <span style={kbd}>{props.keyHint}</span>}
      </button>
    </Tip>
  );
}

/**
 * Reduce w:h to something a person reads as a ratio. An AI result is whatever
 * size the model felt like, and its lowest terms are usually nonsense like
 * 1195:896 - so anything that does not land near a familiar ratio is shown as
 * a decimal instead.
 */
function ratioLabel(w: number, h: number): string {
  if (!w || !h) return "-";
  const r = w / h;
  const common: [string, number][] = [
    ["1:1", 1], ["3:2", 3 / 2], ["2:3", 2 / 3], ["4:3", 4 / 3], ["3:4", 3 / 4],
    ["16:9", 16 / 9], ["9:16", 9 / 16], ["21:9", 21 / 9], ["5:4", 5 / 4], ["4:5", 4 / 5],
  ];
  for (const [name, value] of common) {
    if (Math.abs(r - value) / value < 0.01) return name;
  }
  return `${r.toFixed(2)}:1`;
}

/** Reference data and history, out of the way along the bottom of the stage. */
function StatusBar(props: { img: HTMLImageElement | null; zoom: number }) {
  const w = props.img?.naturalWidth ?? 0;
  const h = props.img?.naturalHeight ?? 0;

  return (
    <div style={statusBar}>
      <span>{w ? `${w} × ${h} px` : "-"}</span>
      <Dot />
      <span>{w ? `${((w * h) / 1_000_000).toFixed(2)} MP` : "-"}</span>
      <Dot />
      <span>{ratioLabel(w, h)}</span>
      <Dot />
      <span>{Math.round(props.zoom * 100)}%</span>
    </div>
  );
}

function Dot() {
  return <span style={{ opacity: 0.35 }}>·</span>;
}

function Field({ label: lbl, hint: h, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <span style={label}>{lbl}</span>
      {children}
      {h && <span style={{ ...hint, fontSize: 11 }}>{h}</span>}
    </div>
  );
}

function Toast({
  tone,
  onClose,
  children,
}: {
  tone: "error" | "notice";
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={tone === "error" ? errorBox : noticeBox}>
      <span style={{ flex: 1 }}>{children}</span>
      <button onClick={onClose} style={{ ...iconBtn, color: "inherit" }} title="Dismiss">
        ×
      </button>
    </div>
  );
}

/**
 * A native <select> renders as an opaque OS widget that ignores the rest of the
 * page's styling, which is jarring in a dark editor. This is the same control
 * with the app's own look, and the keyboard behaviour people expect from one.
 */
function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  const commit = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActiveIdx((i) => Math.min(options.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? commit(activeIdx) : setOpen(true);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }} onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          ...selectBtn,
          borderColor: open ? "var(--accent)" : "var(--border)",
          color: selected ? "var(--text)" : "var(--muted)",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? placeholder}
        </span>
        <span style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform .12s" }}>
          ▾
        </span>
      </button>

      {open && (
        <div role="listbox" style={selectMenu}>
          {options.length === 0 && <div style={{ ...selectOption, color: "var(--muted)" }}>Nothing to pick</div>}
          {options.map((o, i) => {
            const isSel = o.value === value;
            return (
              <div
                key={o.value}
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(i)}
                style={{
                  ...selectOption,
                  background: i === activeIdx ? "var(--panel-2)" : "transparent",
                  color: isSel ? "var(--accent)" : "var(--text)",
                  fontWeight: isSel ? 600 : 400,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                {isSel && <span>✓</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =========================== styles =========================== */
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600 };

const sidebar: React.CSSProperties = {
  width: 194,
  flexShrink: 0,
  background: "var(--panel)",
  borderRight: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden", // the history list scrolls, not the whole sidebar
};
const emptyStage: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: 24,
  pointerEvents: "none",
};
const historyWrap: React.CSSProperties = {
  flexShrink: 0,
  borderTop: "1px solid var(--border)",
  background: "rgba(0,0,0,0.15)",
};
const stepRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 12px",
};
const stepArrow: React.CSSProperties = {
  width: 34,
  padding: "5px 0",
  fontSize: 11,
  borderRadius: 6,
};
const stepCount: React.CSSProperties = {
  flex: 1,
  textAlign: "center",
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};
const miniBtn: React.CSSProperties = {
  flex: 1,
  padding: "5px 4px",
  fontSize: 11,
  borderRadius: 6,
};
const comparingBtn: React.CSSProperties = {
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
};
const brand: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: 0.3,
  padding: "16px 14px 14px",
};
const groupLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  color: "var(--muted)",
  opacity: 0.7,
  padding: "14px 14px 6px",
};
const entry: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  border: "none",
  borderRadius: 0,
  padding: "8px 12px",
  fontSize: 13,
  textAlign: "left",
};
const entryMark: React.CSSProperties = { fontSize: 12, color: "var(--muted)", opacity: 0.8 };
const saveWhere: React.CSSProperties = {
  padding: "2px 14px 0",
  fontSize: 10.5,
  lineHeight: 1.45,
  color: "var(--muted)",
  opacity: 0.85,
  wordBreak: "break-word",
};
const kbd: React.CSSProperties = {
  fontSize: 10,
  color: "var(--muted)",
  opacity: 0.75,
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 4px",
  whiteSpace: "nowrap",
};
const unsavedDot: React.CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--accent)",
  marginLeft: 6,
  verticalAlign: "middle",
};
const tipCard: React.CSSProperties = {
  position: "fixed",
  zIndex: 200, // over the transform popup and the side panel both
  width: 252,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(30,30,37,0.97)",
  border: "1px solid var(--border)",
  boxShadow: "0 16px 44px rgba(0,0,0,0.6)",
  backdropFilter: "blur(8px)",
  pointerEvents: "none", // never let the help get in the way of the control
};
const tipArrow: React.CSSProperties = {
  position: "absolute",
  left: -5,
  width: 9,
  height: 9,
  transform: "rotate(45deg)",
  background: "rgba(30,30,37,0.97)",
  borderLeft: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
};
const popupCatcher: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 40 };
const popup: React.CSSProperties = {
  position: "fixed",
  zIndex: 41,
  width: 236,
  display: "grid",
  gap: 6,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  boxShadow: "0 18px 50px rgba(0,0,0,0.6)",
};

const sidePanel: React.CSSProperties = {
  width: 300,
  flexShrink: 0,
  background: "var(--panel)",
  borderLeft: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
};
const panelHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 12px 14px 16px",
  borderBottom: "1px solid var(--border)",
  position: "sticky",
  top: 0,
  background: "var(--panel)",
  zIndex: 1,
};
const panelBody: React.CSSProperties = { padding: 16, display: "grid", gap: 14 };
const iconBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--muted)",
  fontSize: 16,
  lineHeight: 1,
};
const valueBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: "0 2px",
  fontSize: 12,
  fontWeight: 600,
};

const statusBar: React.CSSProperties = {
  height: 34,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 12px",
  borderTop: "1px solid var(--border)",
  background: "var(--panel)",
  fontSize: 11,
  color: "var(--muted)",
};

const selectBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 13,
  textAlign: "left",
};
const selectMenu: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  zIndex: 50,
  maxHeight: 240,
  overflowY: "auto",
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 4,
  boxShadow: "0 16px 40px rgba(0,0,0,0.6)",
};
const selectOption: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "7px 8px",
  borderRadius: 6,
  fontSize: 13,
  cursor: "pointer",
};

const toastWrap: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 30,
  display: "grid",
  gap: 8,
  width: "min(560px, calc(100% - 32px))",
};
const compareBadge: React.CSSProperties = {
  width: "100%",
  background: "rgba(76,141,255,0.16)",
  border: "1px solid rgba(76,141,255,0.5)",
  color: "#cfe0ff",
  padding: "7px 12px",
  borderRadius: 10,
  fontSize: 12,
  lineHeight: 1.4,
  textAlign: "center",
  backdropFilter: "blur(8px)",
};
const aiBar: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 18,
  transform: "translateX(-50%)",
  width: "min(680px, calc(100% - 32px))",
  background: "rgba(23,23,28,0.92)",
  backdropFilter: "blur(8px)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
};
const cropReadout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "var(--panel-2)",
  border: "1px solid var(--border)",
  fontSize: 12,
  color: "var(--muted)",
};
const rerunBtn: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  padding: "4px 8px",
};
const ellipsis: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const fillButton: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  marginTop: 8,
  padding: "8px 10px",
  fontSize: 12,
  fontWeight: 600,
  textAlign: "left",
  background: "rgba(76,141,255,0.14)",
  border: "1px solid rgba(76,141,255,0.5)",
  color: "#cfe0ff",
  borderRadius: 9,
};
const segmented: React.CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 2,
  borderRadius: 8,
  background: "var(--bg)",
  border: "1px solid var(--border)",
};
const segment: React.CSSProperties = {
  width: 26,
  padding: "3px 0",
  border: "none",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.4,
  fontVariantNumeric: "tabular-nums",
};
const thumbBtn: React.CSSProperties = {
  flexShrink: 0,
  width: 72,
  padding: 4,
  display: "grid",
  gap: 3,
  justifyItems: "center",
  border: "1px solid var(--border)",
  borderRadius: 9,
  background: "var(--panel-2)",
};
const thumbImg: React.CSSProperties = {
  width: 62,
  height: 62,
  objectFit: "cover",
  borderRadius: 6,
  display: "block",
  background: "repeating-conic-gradient(#141418 0% 25%, #101014 0% 50%) 50% / 10px 10px",
};
const thumbLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, lineHeight: 1.2 };
const aiBusyOverlay: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  color: "var(--muted)",
  marginBottom: 10,
};
const errorBox: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  background: "rgba(255,92,92,0.14)",
  border: "1px solid rgba(255,92,92,0.4)",
  color: "#ffb3b3",
  padding: "8px 6px 8px 12px",
  borderRadius: 10,
  fontSize: 12,
  lineHeight: 1.5,
  backdropFilter: "blur(8px)",
};
const noticeBox: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  background: "rgba(23,23,28,0.94)",
  border: "1px solid var(--border)",
  color: "var(--muted)",
  padding: "8px 6px 8px 12px",
  borderRadius: 10,
  fontSize: 12,
  lineHeight: 1.5,
  backdropFilter: "blur(8px)",
};
