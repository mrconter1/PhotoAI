"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { AiSettings, EditorHandle, EditorStatus, MAX_VERSIONS } from "./Editor";
import { dropCard, dropOverlay, hint, modalBackdrop, modalCard } from "./styles";
import { ModelInfo } from "@/lib/providers";

// A tab is a photo. The file is fixed when the tab is made; everything that
// happens to the photo afterwards lives inside the tab's own Editor.
type Tab = { id: number; file: File | null };

const DEFAULT_AI: AiSettings = { model: "", aspect: "", size: "", count: 1 };

/**
 * The tabs, and everything that has to see across them: opening files (each
 * into its own tab), the drop zone, the close prompt, and the AI settings,
 * which are one preference rather than one per photo.
 *
 * Every tab's Editor stays mounted while hidden. A 24 MP photo with a history
 * behind it is not something to tear down and rebuild on every switch, and a
 * hidden editor costs nothing but the memory its blobs already take.
 */
export default function Workspace() {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, file: null }]);
  const [activeId, setActiveId] = useState(1);
  const nextId = useRef(2);
  const [status, setStatus] = useState<Record<number, EditorStatus>>({});
  const handles = useRef(new Map<number, EditorHandle>());
  const [pendingClose, setPendingClose] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // ---- AI settings, shared and persisted ------------------------------------
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [ai, setAiState] = useState<AiSettings>(DEFAULT_AI);
  const setAi = useCallback((patch: Partial<AiSettings>) => setAiState((a) => ({ ...a, ...patch })), []);
  const hydrated = useRef(false);

  // restore saved AI settings (client-only) before anything overrides them
  useEffect(() => {
    try {
      const raw = localStorage.getItem("photoai:ai");
      if (raw) {
        const s = JSON.parse(raw);
        const patch: Partial<AiSettings> = {};
        if (typeof s.model === "string") patch.model = s.model;
        if (typeof s.aspect === "string") patch.aspect = s.aspect;
        if (typeof s.size === "string") patch.size = s.size;
        if (Number.isInteger(s.count)) patch.count = Math.min(MAX_VERSIONS, Math.max(1, s.count));
        setAi(patch);
      }
    } catch {}
    hydrated.current = true;
  }, [setAi]);

  // persist AI settings whenever they change (after hydration)
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      localStorage.setItem("photoai:ai", JSON.stringify(ai));
    } catch {}
  }, [ai]);

  // load available image models once, from every provider with a key. A saved
  // choice that is no longer on the list (key removed, model retired) falls
  // back to the default rather than failing on the first Generate.
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.models) && d.models.length) {
          const list = d.models as ModelInfo[];
          setModels(list);
          setAiState((a) => ({
            ...a,
            model: list.some((m) => m.id === a.model) ? a.model : d.default || list[0].id,
          }));
        }
      })
      .catch(() => {});
  }, []);

  // ---- tabs -----------------------------------------------------------------
  /**
   * One new tab per file, and the first of them takes the stage. An empty tab
   * (the one the app starts with, or one left after the last close) is
   * replaced rather than kept beside them - it was only there to have
   * somewhere to drop the photo.
   */
  const openFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    const fresh = files.map((file) => ({ id: nextId.current++, file }));
    setTabs((t) => [...t.filter((x) => x.file !== null), ...fresh]);
    setActiveId(fresh[0].id);
  }, []);

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const closeTab = useCallback(
    (id: number) => {
      setPendingClose(null);
      handles.current.delete(id);
      setStatus((s) => {
        const { [id]: _gone, ...rest } = s;
        return rest;
      });
      const i = tabs.findIndex((x) => x.id === id);
      const rest = tabs.filter((x) => x.id !== id);
      // The neighbour to the right takes over, as in every other tab strip;
      // the last tab is never closed without something taking its place.
      if (!rest.length) {
        const empty = { id: nextId.current++, file: null };
        setTabs([empty]);
        setActiveId(empty.id);
        return;
      }
      setTabs(rest);
      if (activeId === id) setActiveId(rest[Math.min(i, rest.length - 1)].id);
    },
    [tabs, activeId]
  );

  /** Close, or ask first if the photo has edits that were never saved. */
  const requestClose = useCallback(
    (id: number) => {
      if (status[id]?.dirty) setPendingClose(id);
      else closeTab(id);
    },
    [status, closeTab]
  );

  // Each tab reports into its own slot. The callback is made once per tab id
  // so the editor's status effect does not fire on every workspace render.
  const statusSetters = useRef(new Map<number, (s: EditorStatus) => void>());
  const statusSetter = (id: number) => {
    let f = statusSetters.current.get(id);
    if (!f) {
      f = (s: EditorStatus) => setStatus((all) => ({ ...all, [id]: s }));
      statusSetters.current.set(id, f);
    }
    return f;
  };

  // Alt+1..9 switch tabs; Ctrl+digit and Ctrl+Tab belong to the browser.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
      const t = tabs[Number(e.key) - 1];
      if (!t) return;
      e.preventDefault();
      setActiveId(t.id);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [tabs]);

  // Leaving the page with unsaved edits gets the browser's own "are you sure".
  useEffect(() => {
    const anyDirty = Object.values(status).some((s) => s.dirty);
    if (!anyDirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [status]);

  // ---- drag and drop --------------------------------------------------------
  // Files dropped anywhere but the stage used to be handled by the browser,
  // which navigates the tab to the image and takes every unsaved edit with it.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  // dragenter/dragleave fire for every child the pointer crosses, so the depth
  // is counted rather than toggled - otherwise the hint flickers on the way in.
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    openFiles(Array.from(e.dataTransfer.files ?? []));
  };

  const tabName = (t: Tab) => status[t.id]?.name ?? t.file?.name ?? "New tab";
  const closing = pendingClose !== null ? tabs.find((t) => t.id === pendingClose) : undefined;
  // The strip is noise while there is one photo and nothing to switch to.
  const showStrip = tabs.length > 1 || tabs[0].file !== null;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100vh" }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {showStrip && (
        <div style={strip} role="tablist">
          {tabs.map((t, i) => {
            const on = t.id === activeId;
            const st = status[t.id];
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={on}
                title={`${tabName(t)}${i < 9 ? ` (Alt+${i + 1})` : ""}`}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) requestClose(t.id); // middle click closes
                }}
                style={{
                  ...tab,
                  background: on ? "var(--bg)" : "transparent",
                  color: on ? "var(--text)" : "var(--muted)",
                  borderBottomColor: on ? "var(--bg)" : "var(--border)",
                }}
              >
                <span style={tabLabel}>{tabName(t)}</span>
                {st?.dirty && <span style={dirtyDot} title="Unsaved changes" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    requestClose(t.id);
                  }}
                  aria-label={`Close ${tabName(t)}`}
                  title="Close tab"
                  style={closeBtn}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button onClick={openPicker} style={newTabBtn} title="Open photos in new tabs (Ctrl+O)" aria-label="Open">
            +
          </button>
        </div>
      )}

      {tabs.map((t) => (
        <Editor
          key={t.id}
          ref={(h) => {
            if (h) handles.current.set(t.id, h);
            else handles.current.delete(t.id);
          }}
          active={t.id === activeId}
          file={t.file}
          onOpen={openPicker}
          onStatus={statusSetter(t.id)}
          models={models}
          ai={ai}
          setAi={setAi}
        />
      ))}

      {/* hidden picker used by Open / Ctrl+O / the + on the strip */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ""; // allow re-picking the same file
          openFiles(files);
        }}
      />

      {/* drop hint, over everything while a file is being dragged in */}
      {dragging && (
        <div style={dropOverlay}>
          <div style={dropCard}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>🖼️</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Drop photos to open them</div>
            <div style={{ ...hint, marginTop: 4 }}>Each one opens in its own tab.</div>
          </div>
        </div>
      )}

      {/* the one question a tab can ask on its way out */}
      {closing && (
        <div style={modalBackdrop} onClick={() => setPendingClose(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 6px", fontSize: 17 }}>Unsaved changes</h2>
            <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              <strong style={{ color: "var(--text)" }}>{tabName(closing)}</strong> has edits that haven&apos;t been
              saved yet. Close it anyway and they are lost.
              {status[closing.id]?.choosing && (
                <>
                  {" "}
                  It also has AI versions waiting to be picked; saving needs that answered first.
                </>
              )}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={() => setPendingClose(null)}>Cancel</button>
              <button
                disabled={!!status[closing.id]?.choosing}
                onClick={async () => {
                  // Only go on if the save actually happened - cancelling the
                  // Save dialog must not throw the edits away.
                  const saved = await handles.current.get(closing.id)?.save();
                  if (saved) closeTab(closing.id);
                }}
              >
                Save &amp; close
              </button>
              <button className="primary" onClick={() => closeTab(closing.id)}>
                Discard &amp; close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================== styles =========================== */
const strip: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  flexShrink: 0,
  height: 36,
  paddingLeft: 6,
  background: "var(--panel)",
  borderBottom: "1px solid var(--border)",
  overflowX: "auto",
  overflowY: "hidden",
};
const tab: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  maxWidth: 220,
  minWidth: 0,
  margin: "4px 0 -1px",
  padding: "0 4px 0 12px",
  fontSize: 12.5,
  cursor: "pointer",
  userSelect: "none",
  border: "1px solid var(--border)",
  borderBottom: "1px solid var(--border)",
  borderRadius: "8px 8px 0 0",
  marginRight: 2,
};
const tabLabel: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
const dirtyDot: React.CSSProperties = {
  display: "inline-block",
  flexShrink: 0,
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--accent)",
};
const closeBtn: React.CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  fontSize: 15,
  lineHeight: 1,
  borderRadius: 5,
  opacity: 0.7,
};
const newTabBtn: React.CSSProperties = {
  alignSelf: "center",
  width: 26,
  height: 26,
  padding: 0,
  marginLeft: 4,
  border: "none",
  background: "transparent",
  color: "var(--muted)",
  fontSize: 18,
  lineHeight: 1,
};
