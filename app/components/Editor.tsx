"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AI_MAX_EDGE,
  Adjustments,
  CropRect,
  NEUTRAL_ADJUSTMENTS,
  adjustmentsToFilter,
  bakeToUrl,
  download,
  encodeForUpload,
  formatBytes,
  loadImage,
  openImageFile,
  revoke,
} from "@/lib/image";
import CropOverlay from "./CropOverlay";

// "none" = plain pan/move mode (always available); crop/ai are the active tools
type Tool = "none" | "crop" | "ai";
type PanelTab = "settings" | "transform" | "ai" | "info";
type Viewport = { zoom: number; x: number; y: number };

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
// Each history entry is a full-resolution PNG blob, so the depth is bounded:
// 40 steps on a 24 MP photo is already north of a gigabyte of blob storage.
const MAX_HISTORY = 40;
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

export default function Editor() {
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

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [tool, setTool] = useState<Tool>("none");
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [cropAspect, setCropAspect] = useState<number | null>(null); // pixel w/h; null = free
  const [panelTab, setPanelTab] = useState<PanelTab>("settings");

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // non-fatal, e.g. downscaled on open
  const [lastUpload, setLastUpload] = useState<string | null>(null); // what the last AI run sent
  const [savedUrl, setSavedUrl] = useState<string | null>(null); // last opened/saved image
  const savedUrlRef = useRef<string | null>(null);
  savedUrlRef.current = savedUrl;
  const [confirmOpen, setConfirmOpen] = useState(false); // unsaved-changes dialog
  const openInputRef = useRef<HTMLInputElement>(null);

  // AI settings
  const [models, setModels] = useState<string[]>([]);
  const [aiModel, setAiModel] = useState("");
  const [aiAspect, setAiAspect] = useState(""); // "" = match input
  const [aiSize, setAiSize] = useState(""); // "" = model default
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const hydrated = useRef(false);

  // restore saved AI settings (client-only) before anything overrides them
  useEffect(() => {
    try {
      const raw = localStorage.getItem("photoai:ai");
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.model === "string") setAiModel(s.model);
        if (typeof s.aspect === "string") setAiAspect(s.aspect);
        if (typeof s.size === "string") setAiSize(s.size);
      }
    } catch {}
    hydrated.current = true;
  }, []);

  // persist AI settings whenever they change (after hydration)
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem("photoai:ai", JSON.stringify({ model: aiModel, aspect: aiAspect, size: aiSize }));
    } catch {}
  }, [aiModel, aiAspect, aiSize]);

  // load available image models once
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.models)) {
          setModels(d.models);
          setAiModel((m) => m || d.default || d.models[0] || "");
        }
      })
      .catch(() => {});
  }, []);

  // auto-focus the prompt when the AI tool is chosen
  useEffect(() => {
    if (tool === "ai") aiInputRef.current?.focus();
  }, [tool]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  // ---- image + stage sizing -------------------------------------------------
  // The on-screen framing to preserve across history/AI swaps (stage px).
  // Updated only by user zoom/pan and file open — NOT by image swaps — so
  // toggling between different-resolution versions keeps a constant size.
  const frame = useRef<{ cx: number; cy: number; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    loadImage(current).then((el) => {
      if (cancelled) return;
      setImg(el);
      if (pendingFit.current) return; // a fresh open fits itself (see below)
      const f = frame.current;
      if (!f) return;
      // fit the new image into the remembered frame, centered on the same point
      const zoom = Math.min(f.w / el.naturalWidth, f.h / el.naturalHeight);
      fromSwap.current = true; // this view change must NOT move the frame
      setView({ zoom, x: f.cx - (el.naturalWidth * zoom) / 2, y: f.cy - (el.naturalHeight * zoom) / 2 });
    });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // Remember the current framing whenever the user zooms/pans or fits/opens,
  // but ignore view changes that came from an image swap (guarded above).
  const fromSwap = useRef(false);
  useEffect(() => {
    if (!img) return;
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
  const pushState = useCallback((url: string, mime = "image/png") => {
    typesRef.current.set(url, mime);
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
      // A downscale on open re-encodes to PNG; otherwise it is the file itself.
      typesRef.current.set(url, scaledFrom ? "image/png" : file.type || "image/png");
      pendingFit.current = true; // fit the newly opened image
      togglePair.current = null;
      historyRef.current = [url];
      indexRef.current = 0;
      setHistory([url]);
      setIndex(0);
      setImg(el);
      setAdjust(NEUTRAL_ADJUSTMENTS);
      setSavedUrl(url); // freshly opened = clean
      setTool("none");
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

  const flatten = useCallback(async (): Promise<HTMLImageElement> => {
    if (!img) throw new Error("No image.");
    const dirty = adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS);
    if (!dirty) return img;
    const baked = await bakeToUrl(img, { rotate: 0, flipH: false, flipV: false }, adjust, null);
    const el = await loadImage(baked);
    pushState(baked);
    return el;
  }, [img, adjust, pushState]);

  const applyTransform = useCallback(
    async (rotate: number, flipH = false, flipV = false) => {
      if (!img) return;
      try {
        pushState(await bakeToUrl(img, { rotate, flipH, flipV }, adjust, null));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not apply the transform.");
      }
    },
    [img, adjust, pushState]
  );

  const applyCrop = useCallback(async () => {
    if (!img) return;
    try {
      pushState(await bakeToUrl(img, { rotate: 0, flipH: false, flipV: false }, adjust, crop));
      setCrop(FULL_CROP);
      setTool("none");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply the crop.");
    }
  }, [img, adjust, crop, pushState]);

  // Locked crop ratio expressed in normalized (w/h) units for the overlay.
  const cropNormRatio = cropAspect && img ? cropAspect * (img.naturalHeight / img.naturalWidth) : null;
  const chooseCropAspect = useCallback(
    (px: number | null) => {
      setCropAspect(px);
      if (px && img) {
        const nr = px * (img.naturalHeight / img.naturalWidth);
        setCrop((c) => {
          const cx = c.x + c.w / 2;
          const cy = c.y + c.h / 2;
          const w = c.w;
          const h = w / nr;
          return { x: cx - w / 2, y: cy - h / 2, w, h };
        });
      }
    },
    [img]
  );

  const runAI = useCallback(async () => {
    if (!img || !aiPrompt.trim()) return;
    setError(null);
    setAiBusy(true);
    try {
      const flat = await flatten();

      // The full-resolution photo never leaves the browser: it is downscaled to
      // the model's working size and compressed first, which is what keeps a
      // 60 MP upload from timing out (or being refused) on the way to Google.
      const { blob, width, height } = await encodeForUpload(
        flat,
        AI_MAX_EDGE[aiSize] ?? AI_MAX_EDGE[""]
      );
      setLastUpload(`${width} × ${height} px · ${formatBytes(blob.size)}`);

      const form = new FormData();
      form.append("image", blob, "image.webp");
      form.append("prompt", aiPrompt.trim());
      if (aiModel) form.append("model", aiModel);
      if (aiAspect) form.append("aspectRatio", aiAspect);
      if (aiSize) form.append("imageSize", aiSize);

      const res = await fetch("/api/ai-edit", { method: "POST", body: form });
      if (!res.ok) throw new Error(await errorFromResponse(res));

      const out = await res.blob();
      if (out.size === 0) throw new Error("The model returned an empty image.");
      pushState(URL.createObjectURL(out), out.type || "image/png");
      setAiPrompt(""); // clear on success; stay on the AI tool for the next edit
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setAiBusy(false);
    }
  }, [img, aiPrompt, aiModel, aiAspect, aiSize, flatten, pushState]);

  const doDownload = useCallback(async () => {
    try {
      const flat = await flatten();
      const mime = typesRef.current.get(flat.src) || "image/png";
      const ext = EXT[mime] || "png";
      download(flat.src, `photoai-export.${ext}`);
      setSavedUrl(flat.src); // saving marks the current image clean
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export the image.");
    }
  }, [flatten]);

  // Unsaved changes = current differs from the last opened/saved image,
  // or there are uncommitted live adjustments.
  const dirty =
    current !== null &&
    (current !== savedUrl ||
      adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS));

  const triggerPicker = useCallback(() => openInputRef.current?.click(), []);
  const requestOpen = useCallback(() => {
    if (dirty) setConfirmOpen(true);
    else triggerPicker();
  }, [dirty, triggerPicker]);

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

  // Ctrl+Shift+Z: walk backward through the full history, one step per press.
  const stepBack = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    togglePair.current = null;
    setIndex((i) => Math.max(0, i - 1));
  }, []);
  const stepForward = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
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

  // re-fit the image when entering/exiting fullscreen (stage size changes)
  useEffect(() => {
    const onFs = () => {
      pendingFit.current = true;
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

  // keep latest tool/applyCrop for the (stable) key handler
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const applyCropRef = useRef(applyCrop);
  applyCropRef.current = applyCrop;
  const downloadRef = useRef(doDownload);
  downloadRef.current = doDownload;
  const fitRef = useRef(fitToScreen);
  fitRef.current = fitToScreen;
  const requestOpenRef = useRef(requestOpen);
  requestOpenRef.current = requestOpen;

  // space-to-pan + shortcuts
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    const down = (e: KeyboardEvent) => {
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
        requestOpenRef.current(); // open new photo (guards unsaved changes)
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        // single-key tool / panel shortcuts
        const k = e.key.toLowerCase();
        const handled =
          ["c", "a", "v", "escape", "i", "t", "f", "r"].includes(k) ||
          (e.key === "Enter" && toolRef.current === "crop");
        if (handled) e.preventDefault(); // don't let the key type into a field it may focus
        if (k === "c") setTool("crop");
        else if (k === "a") setTool("ai");
        else if (k === "v" || k === "escape") setTool("none");
        else if (k === "i") setPanelTab("settings");
        else if (k === "t") setPanelTab("transform");
        else if (k === "f") toggleFullscreen();
        else if (k === "r") fitRef.current();
        else if (e.key === "Enter" && toolRef.current === "crop") applyCropRef.current();
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
  const cursor = panning ? "grabbing" : tool === "crop" ? "default" : "grab";

  if (!current) return <Dropzone onFile={openFile} error={error} />;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* LEFT TOOL RAIL */}
      <ToolRail
        tool={tool}
        setTool={setTool}
        onZoomIn={() => zoomButton(1.25)}
        onZoomOut={() => zoomButton(1 / 1.25)}
        onFit={() => fitToScreen()}
        onFullscreen={toggleFullscreen}
      />

      {/* CENTER STAGE */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar
          onToggle={toggleLast}
          onBack={stepBack}
          onForward={stepForward}
          canBack={index > 0}
          canForward={index < history.length - 1}
          onOpen={requestOpen}
          onDownload={doDownload}
          step={index}
          total={history.length}
          cropMode={tool === "crop"}
          cropAspect={cropAspect}
          onCropAspect={chooseCropAspect}
        />
        <div
          ref={stageRef}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void openFile(f);
          }}
          style={{
            position: "relative",
            flex: 1,
            overflow: "hidden",
            cursor,
            background:
              "repeating-conic-gradient(#141418 0% 25%, #101014 0% 50%) 50% / 24px 24px",
          }}
        >
          {imgBox && (
            <>
              <img
                src={current}
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
              {tool === "crop" && <CropOverlay imgBox={imgBox} value={crop} onChange={setCrop} ratio={cropNormRatio} />}
            </>
          )}

          {/* floating zoom badge */}
          <div style={zoomBadge}>{Math.round(view.zoom * 100)}%</div>

          {/* floating AI prompt bar, below the image */}
          {tool === "ai" && (
            <div style={aiBar}>
              {aiBusy && (
                <div style={aiBusyOverlay}>
                  <span className="spinner" />
                  <span style={{ fontSize: 12 }}>Generating with {aiModel || "model"}…</span>
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
                <button className="primary" onClick={runAI} disabled={aiBusy || !aiPrompt.trim()} style={{ height: 40 }} title="Ctrl+Enter">
                  {aiBusy ? "…" : "Generate"}
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {["Remove background", "Black & white film", "Enhance & sharpen", "Golden-hour light"].map((p) => (
                  <button key={p} style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setAiPrompt(p)} disabled={aiBusy}>
                    {p}
                  </button>
                ))}
                <span style={{ ...hint, fontSize: 11, marginLeft: "auto", alignSelf: "center" }}>
                  {lastUpload
                    ? `Sent ${lastUpload}`
                    : `Sends a copy at up to ${AI_MAX_EDGE[aiSize] ?? AI_MAX_EDGE[""]} px`}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* RIGHT SETTINGS (always visible) */}
      <aside style={{ width: 300, background: "var(--panel)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {error && <div style={{ ...errorBox, margin: 16 }}>{error}</div>}
        {notice && (
          <div style={{ ...noticeBox, margin: error ? "0 16px 16px" : 16 }}>
            {notice}
            <button onClick={() => setNotice(null)} style={dismissBtn} title="Dismiss">×</button>
          </div>
        )}

        {tool === "crop" && (
          <Section title="Crop">
            <p style={hint}>Pick a ratio in the top bar, or drag freely. Pull handles past the edge to crop out. Press Enter to apply.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ flex: 1 }} onClick={() => { setCrop(FULL_CROP); chooseCropAspect(null); }}>Reset</button>
              <button className="primary" style={{ flex: 1 }} onClick={applyCrop}>Apply crop</button>
            </div>
          </Section>
        )}

        {/* Tabbed settings — always available */}
        <RightPanel
          adjust={adjust}
          setAdjust={setAdjust}
          onCommit={() => void flatten()}
          onTransform={applyTransform}
          img={img}
          zoom={view.zoom}
          step={index}
          total={history.length}
          models={models}
          aiModel={aiModel}
          setAiModel={setAiModel}
          aiAspect={aiAspect}
          setAiAspect={setAiAspect}
          aiSize={aiSize}
          setAiSize={setAiSize}
          tab={panelTab}
          setTab={setPanelTab}
        />
      </aside>

      {/* hidden picker used by Open / Ctrl+O */}
      <input
        ref={openInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) void openFile(f);
        }}
      />

      {/* unsaved-changes confirmation */}
      {confirmOpen && (
        <div style={modalBackdrop} onClick={() => setConfirmOpen(false)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Unsaved changes</h2>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              You have edits that haven&apos;t been saved. Opening a new photo will discard them.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button
                onClick={async () => {
                  setConfirmOpen(false);
                  await doDownload();
                  triggerPicker();
                }}
              >
                Save &amp; open
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirmOpen(false);
                  triggerPicker();
                }}
              >
                Discard &amp; open
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================== sub-views =========================== */

function ToolRail(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onFullscreen: () => void;
}) {
  const tools: [Tool, string, string][] = [
    ["crop", "▢", "Crop  (C)"],
    ["ai", "✨", "AI Edit  (A)"],
  ];
  return (
    <div style={{ width: 56, background: "var(--panel)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0", gap: 6 }}>
      {tools.map(([id, icon, title]) => (
        <RailButton key={id} active={props.tool === id} title={title} onClick={() => props.setTool(id)}>
          {icon}
        </RailButton>
      ))}
      <div style={{ flex: 1 }} />
      <RailButton title="Zoom in  (scroll up)" onClick={props.onZoomIn}>＋</RailButton>
      <RailButton title="Zoom out  (scroll down)" onClick={props.onZoomOut}>－</RailButton>
      <RailButton title="Fit to window  (R)" onClick={props.onFit}>⤢</RailButton>
      <RailButton title="Fullscreen  (F)" onClick={props.onFullscreen}>⛶</RailButton>
    </div>
  );
}

function RailButton({ active, title, onClick, children }: { active?: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 40,
        height: 40,
        padding: 0,
        fontSize: 18,
        borderRadius: 8,
        background: active ? "var(--accent)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
        color: active ? "#fff" : "var(--text)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}

function TopBar(props: {
  onOpen: () => void;
  onToggle: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onDownload: () => void;
  step: number;
  total: number;
  cropMode: boolean;
  cropAspect: number | null;
  onCropAspect: (n: number | null) => void;
}) {
  return (
    <header style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
      <strong style={{ fontSize: 15, letterSpacing: 0.3 }}>Photo<span style={{ color: "var(--accent)" }}>AI</span></strong>
      {props.cropMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 10, paddingLeft: 12, borderLeft: "1px solid var(--border)", overflowX: "auto" }}>
          <span style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>Ratio</span>
          {CROP_RATIOS.map(([lbl, r]) => {
            const active = props.cropAspect === r || (r === null && props.cropAspect === null);
            return (
              <button
                key={lbl}
                onClick={() => props.onCropAspect(r)}
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  whiteSpace: "nowrap",
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
      )}
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: "var(--muted)" }}>step {props.step + 1}/{props.total}</span>
      <button title="Open photo (Ctrl+O)" onClick={props.onOpen}>Open</button>
      <button title="Toggle last change (Ctrl+Z)" onClick={props.onToggle} disabled={!props.canBack}>Toggle</button>
      <button title="Step back (Ctrl+Shift+Z)" onClick={props.onBack} disabled={!props.canBack}>◀ Back</button>
      <button title="Step forward (Ctrl+Y)" onClick={props.onForward} disabled={!props.canForward}>Fwd ▶</button>
      <button className="primary" title="Save image (Ctrl+S)" onClick={props.onDownload}>Download</button>
    </header>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "grid", gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)" }}>{title}</span>
      {children}
    </div>
  );
}

function RightPanel(props: {
  adjust: Adjustments;
  setAdjust: (a: Adjustments) => void;
  onCommit: () => void; // bake current adjustments into history (auto-apply)
  onTransform: (rotate: number, flipH?: boolean, flipV?: boolean) => void;
  img: HTMLImageElement | null;
  zoom: number;
  step: number;
  total: number;
  models: string[];
  aiModel: string;
  setAiModel: (v: string) => void;
  aiAspect: string;
  setAiAspect: (v: string) => void;
  aiSize: string;
  setAiSize: (v: string) => void;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
}) {
  const { adjust, setAdjust, img } = props;
  const pt = props.tab;
  const setPt = props.setTab;
  const tabs: [PanelTab, string][] = [
    ["settings", "Image"],
    ["transform", "Transform"],
    ["ai", "AI Settings"],
    ["info", "Information"],
  ];
  const sliders: [keyof Adjustments, string, number, number][] = [
    ["brightness", "Brightness", 0, 200],
    ["contrast", "Contrast", 0, 200],
    ["saturation", "Saturation", 0, 200],
    ["sepia", "Warmth", 0, 100],
    ["grayscale", "Grayscale", 0, 100],
  ];
  // auto-apply: bake into history when a slider gesture ends
  const commit = () => props.onCommit();

  const w = img?.naturalWidth ?? 0;
  const h = img?.naturalHeight ?? 0;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = w && h ? gcd(w, h) : 1;
  const info: [string, string][] = [
    ["Dimensions", w ? `${w} × ${h} px` : "-"],
    ["Megapixels", w ? `${((w * h) / 1_000_000).toFixed(2)} MP` : "-"],
    ["Aspect ratio", w ? `${w / g} : ${h / g}` : "-"],
    ["Orientation", w ? (w > h ? "Landscape" : w < h ? "Portrait" : "Square") : "-"],
    ["Zoom", `${Math.round(props.zoom * 100)}%`],
    ["History step", `${props.step + 1} / ${props.total}`],
  ];

  return (
    <>
      <div style={{ display: "flex", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--panel)", zIndex: 1 }}>
        {tabs.map(([id, lbl]) => (
          <button
            key={id}
            onClick={() => setPt(id)}
            style={{
              flex: 1,
              border: "none",
              borderRadius: 0,
              background: pt === id ? "var(--panel-2)" : "transparent",
              color: pt === id ? "var(--text)" : "var(--muted)",
              borderBottom: pt === id ? "2px solid var(--accent)" : "2px solid transparent",
              padding: "11px 2px",
              fontSize: 11,
              fontWeight: pt === id ? 600 : 400,
            }}
          >
            {lbl}
          </button>
        ))}
      </div>

      {pt === "settings" && (
        <div style={{ padding: 16, display: "grid", gap: 14 }}>
          {sliders.map(([key, lbl, min, max]) => (
            <div key={key} style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={label}>{lbl}</span>
                <span style={{ ...label, color: "var(--muted)" }}>{adjust[key]}</span>
              </div>
              <input
                type="range"
                min={min}
                max={max}
                value={adjust[key]}
                onChange={(e) => setAdjust({ ...adjust, [key]: Number(e.target.value) })}
                onPointerUp={commit}
                onKeyUp={commit}
                onTouchEnd={commit}
              />
            </div>
          ))}
          <p style={hint}>Adjustments apply automatically. Use Ctrl+Z to step back.</p>
        </div>
      )}

      {pt === "transform" && (
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          <span style={label}>Rotate</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={{ flex: 1 }} onClick={() => props.onTransform(90)}>⟳ 90°</button>
            <button style={{ flex: 1 }} onClick={() => props.onTransform(-90)}>⟲ 90°</button>
            <button style={{ flex: 1 }} onClick={() => props.onTransform(180)}>180°</button>
          </div>
          <span style={label}>Flip</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={{ flex: 1 }} onClick={() => props.onTransform(0, true, false)}>⇋ Horizontal</button>
            <button style={{ flex: 1 }} onClick={() => props.onTransform(0, false, true)}>⇅ Vertical</button>
          </div>
          <p style={hint}>Each transform is applied immediately and added to history.</p>
        </div>
      )}

      {pt === "ai" && (
        <div style={{ padding: 16, display: "grid", gap: 14 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <span style={label}>Model</span>
            <select
              value={props.aiModel}
              onChange={(e) => props.setAiModel(e.target.value)}
              style={selectStyle}
            >
              {props.models.length === 0 && <option value="">Loading…</option>}
              {props.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span style={{ ...hint, marginTop: 2 }}>Fetched from your Google account&apos;s available image models.</span>
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <span style={label}>Aspect ratio</span>
            <select value={props.aiAspect} onChange={(e) => props.setAiAspect(e.target.value)} style={selectStyle}>
              <option value="">Match input</option>
              {["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"].map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: 4 }}>
            <span style={label}>Resolution</span>
            <select value={props.aiSize} onChange={(e) => props.setAiSize(e.target.value)} style={selectStyle}>
              <option value="">Model default</option>
              {["1K", "2K", "4K"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <span style={{ ...hint, marginTop: 2 }}>Aspect ratio &amp; resolution apply where the selected model supports them.</span>
          </div>
        </div>
      )}

      {pt === "info" && (
        <div style={{ padding: 16, display: "grid", gap: 8 }}>
          {info.map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ color: "var(--muted)" }}>{k}</span>
              <span style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Dropzone({ onFile, error }: { onFile: (f: File) => void; error: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 50% 30%, #18181f, #0b0b0e)" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div style={{ textAlign: "center", padding: 48, border: "2px dashed var(--border)", borderRadius: 16, background: "rgba(255,255,255,0.02)", maxWidth: 460 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🖼️</div>
        <h1 style={{ margin: "0 0 6px", fontSize: 24 }}>Photo<span style={{ color: "var(--accent)" }}>AI</span></h1>
        <p style={{ color: "var(--muted)", margin: "0 0 20px", fontSize: 13 }}>Drop a photo here to start. Crop, adjust, and edit with AI.</p>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <button className="primary" onClick={() => fileRef.current?.click()}>Choose a photo</button>
        {error && <div style={{ ...errorBox, marginTop: 20 }}>{error}</div>}
      </div>
    </div>
  );
}

/* =========================== styles =========================== */
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const hint: React.CSSProperties = { fontSize: 12, color: "var(--muted)", margin: 0, lineHeight: 1.5 };
const selectStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "9px 10px",
  fontSize: 13,
  width: "100%",
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
const aiBusyOverlay: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  color: "var(--muted)",
  marginBottom: 10,
};
const zoomBadge: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  background: "rgba(0,0,0,0.6)",
  color: "#fff",
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 6,
  pointerEvents: "none",
};
const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};
const modalCard: React.CSSProperties = {
  width: "min(420px, calc(100% - 32px))",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 22,
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};
const noticeBox: React.CSSProperties = {
  position: "relative",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid var(--border)",
  color: "var(--muted)",
  padding: "8px 26px 8px 10px",
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
};
const dismissBtn: React.CSSProperties = {
  position: "absolute",
  top: 2,
  right: 2,
  width: 22,
  height: 22,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--muted)",
  fontSize: 15,
  lineHeight: 1,
};
const errorBox: React.CSSProperties = {
  background: "rgba(255,92,92,0.12)",
  border: "1px solid rgba(255,92,92,0.4)",
  color: "#ffb3b3",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 12,
};
