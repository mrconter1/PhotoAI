"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Adjustments,
  CropRect,
  NEUTRAL_ADJUSTMENTS,
  adjustmentsToFilter,
  bake,
  download,
  fileToDataUrl,
  loadImage,
} from "@/lib/image";
import CropOverlay from "./CropOverlay";
import BeforeAfter from "./BeforeAfter";

type Tab = "adjust" | "crop" | "ai" | "compare";
type ContainBox = { left: number; top: number; width: number; height: number };

const DEFAULT_CROP: CropRect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

export default function Editor() {
  // history of baked PNG data URLs; index points at the current state
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const current = index >= 0 ? history[index] : null;
  const original = history[0] ?? null;

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [tab, setTab] = useState<Tab>("adjust");
  const [crop, setCrop] = useState<CropRect>(DEFAULT_CROP);

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  // load the current data URL into an <img> element whenever it changes
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    loadImage(current).then((el) => !cancelled && setImg(el));
    return () => {
      cancelled = true;
    };
  }, [current]);

  // track stage size for crop geometry
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pushState = useCallback(
    (dataUrl: string) => {
      setHistory((h) => {
        const next = h.slice(0, index + 1);
        next.push(dataUrl);
        return next;
      });
      setIndex((i) => i + 1);
      setAdjust(NEUTRAL_ADJUSTMENTS);
    },
    [index]
  );

  const openFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const url = await fileToDataUrl(file);
      const el = await loadImage(url);
      setHistory([url]);
      setIndex(0);
      setImg(el);
      setAdjust(NEUTRAL_ADJUSTMENTS);
      setTab("adjust");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open image.");
    }
  }, []);

  // flatten live adjustments into a new committed raster (if any are non-neutral)
  const flatten = useCallback(async (): Promise<HTMLImageElement> => {
    if (!img) throw new Error("No image.");
    const dirty = adjustmentsToFilter(adjust) !== adjustmentsToFilter(NEUTRAL_ADJUSTMENTS);
    if (!dirty) return img;
    const baked = bake(img, { rotate: 0, flipH: false, flipV: false }, adjust, null);
    const el = await loadImage(baked);
    pushState(baked);
    return el;
  }, [img, adjust, pushState]);

  const applyTransform = useCallback(
    (rotate: number, flipH = false, flipV = false) => {
      if (!img) return;
      const baked = bake(img, { rotate, flipH, flipV }, adjust, null);
      pushState(baked);
    },
    [img, adjust, pushState]
  );

  const applyCrop = useCallback(() => {
    if (!img) return;
    const baked = bake(img, { rotate: 0, flipH: false, flipV: false }, adjust, crop);
    pushState(baked);
    setCrop(DEFAULT_CROP);
    setTab("adjust");
  }, [img, adjust, crop, pushState]);

  const applyAdjust = useCallback(() => {
    void flatten();
  }, [flatten]);

  const runAI = useCallback(async () => {
    if (!img || !aiPrompt.trim()) return;
    setError(null);
    setAiBusy(true);
    try {
      const flat = await flatten();
      const res = await fetch("/api/ai-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: flat.src, prompt: aiPrompt.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI request failed.");
      pushState(data.image);
      setTab("compare");
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI request failed.");
    } finally {
      setAiBusy(false);
    }
  }, [img, aiPrompt, flatten, pushState]);

  const doDownload = useCallback(async () => {
    const flat = await flatten();
    download(flat.src, "photoai-export.png");
  }, [flatten]);

  const undo = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    setIndex((i) => Math.max(0, i - 1));
  }, []);
  const redo = useCallback(() => {
    setAdjust(NEUTRAL_ADJUSTMENTS);
    setIndex((i) => Math.min(history.length - 1, i + 1));
  }, [history.length]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // contain-fit box of the image inside the stage (image is always upright)
  const imgBox: ContainBox | null = useMemo(() => {
    if (!img || !stageSize.w || !stageSize.h) return null;
    const scale = Math.min(stageSize.w / img.naturalWidth, stageSize.h / img.naturalHeight);
    const width = img.naturalWidth * scale;
    const height = img.naturalHeight * scale;
    return { left: (stageSize.w - width) / 2, top: (stageSize.h - height) / 2, width, height };
  }, [img, stageSize]);

  const filter = adjustmentsToFilter(adjust);

  if (!current) return <Dropzone onFile={openFile} error={error} />;

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* main stage */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar
          onOpen={openFile}
          onUndo={undo}
          onRedo={redo}
          canUndo={index > 0}
          canRedo={index < history.length - 1}
          onDownload={doDownload}
        />
        <div
          ref={stageRef}
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "radial-gradient(circle at 50% 30%, #1a1a20, #0b0b0e)",
            overflow: "hidden",
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void openFile(f);
          }}
        >
          {tab === "compare" && original && current ? (
            <BeforeAfter before={original} after={current} />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current}
                alt="editing"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  filter,
                  boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
                }}
                draggable={false}
              />
              {tab === "crop" && imgBox && (
                <CropOverlay imgBox={imgBox} value={crop} onChange={setCrop} />
              )}
            </>
          )}
        </div>
      </div>

      {/* sidebar */}
      <aside
        style={{
          width: 320,
          background: "var(--panel)",
          borderLeft: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Tabs tab={tab} setTab={setTab} />
        <div style={{ padding: 16, overflowY: "auto", flex: 1 }}>
          {error && <div style={errorBox}>{error}</div>}

          {tab === "adjust" && (
            <AdjustPanel adjust={adjust} setAdjust={setAdjust} onApply={applyAdjust} onTransform={applyTransform} />
          )}

          {tab === "crop" && (
            <div style={{ display: "grid", gap: 12 }}>
              <p style={hint}>Drag the corners or the box to frame your crop, then apply.</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ flex: 1 }} onClick={() => setCrop(DEFAULT_CROP)}>
                  Reset
                </button>
                <button className="primary" style={{ flex: 1 }} onClick={applyCrop}>
                  Apply crop
                </button>
              </div>
            </div>
          )}

          {tab === "ai" && (
            <div style={{ display: "grid", gap: 12 }}>
              <p style={hint}>
                Describe the edit. Your photo is sent to Google&apos;s image model and the result comes back
                as a new layer.
              </p>
              <textarea
                rows={5}
                placeholder="e.g. Remove the background and make it a clean white studio shot"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <button className="primary" onClick={runAI} disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? "Generating…" : "Run AI edit"}
              </button>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["Remove background", "Make it black & white film", "Enhance and sharpen", "Add golden-hour lighting"].map(
                  (p) => (
                    <button key={p} style={{ fontSize: 11, padding: "5px 8px" }} onClick={() => setAiPrompt(p)}>
                      {p}
                    </button>
                  )
                )}
              </div>
            </div>
          )}

          {tab === "compare" && (
            <p style={hint}>
              Drag the divider on the canvas to compare the original with your current edit. Keep editing from any
              other tab.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ---------- sub-views ---------- */

function TopBar(props: {
  onOpen: (f: File) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onDownload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <header
      style={{
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
      }}
    >
      <strong style={{ fontSize: 15, letterSpacing: 0.3 }}>
        Photo<span style={{ color: "var(--accent)" }}>AI</span>
      </strong>
      <div style={{ flex: 1 }} />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => e.target.files?.[0] && props.onOpen(e.target.files[0])}
      />
      <button onClick={() => fileRef.current?.click()}>Open</button>
      <button onClick={props.onUndo} disabled={!props.canUndo}>
        Undo
      </button>
      <button onClick={props.onRedo} disabled={!props.canRedo}>
        Redo
      </button>
      <button className="primary" onClick={props.onDownload}>
        Download
      </button>
    </header>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: [Tab, string][] = [
    ["adjust", "Adjust"],
    ["crop", "Crop"],
    ["ai", "AI Edit"],
    ["compare", "Compare"],
  ];
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
      {items.map(([id, label]) => (
        <button
          key={id}
          onClick={() => setTab(id)}
          style={{
            flex: 1,
            border: "none",
            borderRadius: 0,
            background: tab === id ? "var(--panel-2)" : "transparent",
            color: tab === id ? "var(--text)" : "var(--muted)",
            borderBottom: tab === id ? "2px solid var(--accent)" : "2px solid transparent",
            padding: "12px 4px",
            fontSize: 12,
            fontWeight: tab === id ? 600 : 400,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function AdjustPanel(props: {
  adjust: Adjustments;
  setAdjust: (a: Adjustments) => void;
  onApply: () => void;
  onTransform: (rotate: number, flipH?: boolean, flipV?: boolean) => void;
}) {
  const { adjust, setAdjust } = props;
  const sliders: [keyof Adjustments, string, number, number][] = [
    ["brightness", "Brightness", 0, 200],
    ["contrast", "Contrast", 0, 200],
    ["saturation", "Saturation", 0, 200],
    ["sepia", "Warmth (sepia)", 0, 100],
    ["grayscale", "Grayscale", 0, 100],
    ["blur", "Blur", 0, 12],
  ];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <span style={label}>Transform</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => props.onTransform(90)}>Rotate ⟳</button>
          <button onClick={() => props.onTransform(-90)}>Rotate ⟲</button>
          <button onClick={() => props.onTransform(0, true, false)}>Flip ⇋</button>
          <button onClick={() => props.onTransform(0, false, true)}>Flip ⇅</button>
        </div>
      </div>

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
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 8 }}>
        <button style={{ flex: 1 }} onClick={() => setAdjust(NEUTRAL_ADJUSTMENTS)}>
          Reset
        </button>
        <button className="primary" style={{ flex: 1 }} onClick={props.onApply}>
          Apply
        </button>
      </div>
    </div>
  );
}

function Dropzone({ onFile, error }: { onFile: (f: File) => void; error: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 50% 30%, #18181f, #0b0b0e)",
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: 48,
          border: "2px dashed var(--border)",
          borderRadius: 16,
          background: "rgba(255,255,255,0.02)",
          maxWidth: 460,
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 8 }}>🖼️</div>
        <h1 style={{ margin: "0 0 6px", fontSize: 24 }}>
          Photo<span style={{ color: "var(--accent)" }}>AI</span>
        </h1>
        <p style={{ color: "var(--muted)", margin: "0 0 20px", fontSize: 13 }}>
          Drop a photo here to start. Crop, adjust, and edit with AI.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <button className="primary" onClick={() => fileRef.current?.click()}>
          Choose a photo
        </button>
        {error && <div style={{ ...errorBox, marginTop: 20 }}>{error}</div>}
      </div>
    </div>
  );
}

/* ---------- styles ---------- */
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const hint: React.CSSProperties = { fontSize: 12, color: "var(--muted)", margin: 0, lineHeight: 1.5 };
const errorBox: React.CSSProperties = {
  background: "rgba(255,92,92,0.12)",
  border: "1px solid rgba(255,92,92,0.4)",
  color: "#ffb3b3",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 12,
  marginBottom: 12,
};
