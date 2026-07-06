"use client";

import { useCallback, useRef, useState } from "react";

type Props = { before: string; after: string };

export default function BeforeAfter({ before, after }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50); // percent
  const dragging = useRef(false);

  const move = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        maxWidth: "100%",
        maxHeight: "100%",
        userSelect: "none",
        touchAction: "none",
        lineHeight: 0,
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerLeave={() => (dragging.current = false)}
    >
      <img src={after} alt="after" style={{ display: "block", maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} draggable={false} />
      <div style={{ position: "absolute", inset: 0, width: `${pos}%`, overflow: "hidden" }}>
        {/* before must render at same box size as after */}
        <img
          src={before}
          alt="before"
          draggable={false}
          style={{ position: "absolute", top: 0, left: 0, width: ref.current?.clientWidth ?? "auto", height: "100%", objectFit: "contain", maxWidth: "none" }}
        />
      </div>

      {/* labels */}
      <span style={badge("left")}>Before</span>
      <span style={badge("right")}>After</span>

      {/* handle */}
      <div
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          move(e.clientX);
        }}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${pos}%`,
          width: 2,
          background: "#fff",
          transform: "translateX(-1px)",
          cursor: "ew-resize",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            width: 34,
            height: 34,
            borderRadius: "50%",
            background: "#fff",
            color: "#111",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          ⇋
        </div>
      </div>
    </div>
  );
}

function badge(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: 10,
    [side]: 10,
    background: "rgba(0,0,0,0.6)",
    color: "#fff",
    fontSize: 11,
    padding: "3px 8px",
    borderRadius: 6,
    lineHeight: 1.4,
  } as React.CSSProperties;
}
