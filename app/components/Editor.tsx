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

type Tool = "move" | "crop" | "ai";
type Viewport = { zoom: number; x: number; y: number };

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

export default function Editor() {
  // full, uncapped history of baked PNG data URLs; index = current state
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const current = index >= 0 ? history[index] : null;

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS);
  const [tool, setTool] = useState<Tool>("move");
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  // ---- image + stage sizing -------------------------------------------------
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    loadImage(current).then((el) => !cancelled && setImg(el));
    return () => {
      cancelled = true;
    };
  }, [current]);

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

  // fit whenever a new image loads or the stage first gets a size
  const fitKey = `${img?.src ?? ""}|${stageSize.w}x${stageSize.h}`;
  const lastFit = useRef("");
  useEffect(() => {
    if (img && stageSize.w && lastFit.current !== fitKey) {
      lastFit.current = fitKey;
      fitToScreen(img, stageSize);
    }
  }, [img, stageSize, fitKey, fitToScreen]);

  // ---- history --------------------------------------------------------------
  const pushState = useCallback(
    (dataUrl: string) => {
      setHistory((h) => [...h.slice(0, index + 1), dataUrl]);
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
      setTool("move");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open image.");
    }
  }, []);

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
      pushState(bake(img, { rotate, flipH, flipV }, adjust, null));
    },
    [img, adjust, pushState]
  );

  const applyCrop = useCallback(() => {
    if (!img) return;
    pushState(bake(img, { rotate: 0, flipH: false, flipV: false }, adjust, crop));
    setCrop(FULL_CROP);
    setTool("move");
  }, [img, adjust, crop, pushState]);

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
      setTool("move");
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

  // space-to-pan + shortcuts
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? stepBack() : toggleLast();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        stepForward();
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [toggleLast, stepBack, stepForward]);

  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const canPan = tool === "move" || spaceDown;
  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!canPan) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setPanning(true);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    setView((v) => ({ ...v, x: pan.current!.vx + (e.clientX - pan.current!.x), y: pan.current!.vy + (e.clientY - pan.current!.y) }));
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
  const cursor = panning ? "grabbing" : canPan ? "grab" : "default";

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
        zoom={view.zoom}
      />

      {/* CENTER STAGE */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar onToggle={toggleLast} onBack={stepBack} onForward={stepForward} canBack={index > 0} canForward={index < history.length - 1} onOpen={openFile} onDownload={doDownload} step={index} total={history.length} />
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
              {tool === "crop" && <CropOverlay imgBox={imgBox} value={crop} onChange={setCrop} />}
            </>
          )}

          {/* floating zoom badge */}
          <div style={zoomBadge}>{Math.round(view.zoom * 100)}%</div>
        </div>
      </div>

      {/* RIGHT SETTINGS (always visible) */}
      <aside style={{ width: 300, background: "var(--panel)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {error && <div style={{ ...errorBox, margin: 16 }}>{error}</div>}

        {tool === "crop" && (
          <Section title="Crop">
            <p style={hint}>Drag the handles - pull them past the photo edge to crop out (extend the canvas).</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ flex: 1 }} onClick={() => setCrop(FULL_CROP)}>Reset</button>
              <button className="primary" style={{ flex: 1 }} onClick={applyCrop}>Apply crop</button>
            </div>
          </Section>
        )}

        {tool === "ai" && (
          <Section title="AI Edit">
            <p style={hint}>Describe a change. Your photo is sent to Google&apos;s image model and returned as a new step.</p>
            <textarea rows={5} placeholder="e.g. Remove the background and make it a clean white studio shot" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
            <button className="primary" onClick={runAI} disabled={aiBusy || !aiPrompt.trim()}>{aiBusy ? "Generating…" : "Run AI edit"}</button>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {["Remove background", "Black & white film", "Enhance & sharpen", "Golden-hour light"].map((p) => (
                <button key={p} style={{ fontSize: 11, padding: "5px 8px" }} onClick={() => setAiPrompt(p)}>{p}</button>
              ))}
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
        />
      </aside>
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
  zoom: number;
}) {
  const tools: [Tool, string, string][] = [
    ["move", "🖐", "Move / Pan  (V, or hold Space)"],
    ["crop", "▢", "Crop  (C)"],
    ["ai", "✨", "AI Edit"],
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
      <RailButton title="Fit to screen" onClick={props.onFit}>⤢</RailButton>
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
  onOpen: (f: File) => void;
  onToggle: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  onDownload: () => void;
  step: number;
  total: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <header style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 16px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
      <strong style={{ fontSize: 15, letterSpacing: 0.3 }}>Photo<span style={{ color: "var(--accent)" }}>AI</span></strong>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: "var(--muted)" }}>step {props.step + 1}/{props.total}</span>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && props.onOpen(e.target.files[0])} />
      <button onClick={() => fileRef.current?.click()}>Open</button>
      <button title="Toggle last change (Ctrl+Z)" onClick={props.onToggle} disabled={!props.canBack}>Toggle</button>
      <button title="Step back (Ctrl+Shift+Z)" onClick={props.onBack} disabled={!props.canBack}>◀ Back</button>
      <button title="Step forward (Ctrl+Y)" onClick={props.onForward} disabled={!props.canForward}>Fwd ▶</button>
      <button className="primary" onClick={props.onDownload}>Download</button>
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

type PanelTab = "settings" | "transform" | "info";

function RightPanel(props: {
  adjust: Adjustments;
  setAdjust: (a: Adjustments) => void;
  onCommit: () => void; // bake current adjustments into history (auto-apply)
  onTransform: (rotate: number, flipH?: boolean, flipV?: boolean) => void;
  img: HTMLImageElement | null;
  zoom: number;
  step: number;
  total: number;
}) {
  const { adjust, setAdjust, img } = props;
  const [pt, setPt] = useState<PanelTab>("settings");
  const tabs: [PanelTab, string][] = [
    ["settings", "Image Settings"],
    ["transform", "Transform"],
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
const errorBox: React.CSSProperties = {
  background: "rgba(255,92,92,0.12)",
  border: "1px solid rgba(255,92,92,0.4)",
  color: "#ffb3b3",
  padding: "8px 10px",
  borderRadius: 8,
  fontSize: 12,
};
