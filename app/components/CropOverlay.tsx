"use client";

import { useCallback, useRef, useState } from "react";
import type { CropRect } from "@/lib/image";

type Props = {
  // pixel rect of the displayed image within the stage
  imgBox: { left: number; top: number; width: number; height: number };
  value: CropRect;
  onChange: (r: CropRect) => void;
};

type Handle = "move" | "nw" | "ne" | "sw" | "se";

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export default function CropOverlay({ imgBox, value, onChange }: Props) {
  const drag = useRef<{ handle: Handle; startX: number; startY: number; start: CropRect } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = useCallback(
    (handle: Handle) => (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { handle, startX: e.clientX, startY: e.clientY, start: value };
      setActive(true);
    },
    [value]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / imgBox.width;
      const dy = (e.clientY - d.startY) / imgBox.height;
      let { x, y, w, h } = d.start;

      if (d.handle === "move") {
        x = clamp(x + dx, 0, 1 - w);
        y = clamp(y + dy, 0, 1 - h);
      } else {
        let x2 = x + w;
        let y2 = y + h;
        if (d.handle.includes("w")) x = clamp(x + dx, 0, x2 - 0.03);
        if (d.handle.includes("e")) x2 = clamp(x2 + dx, x + 0.03, 1);
        if (d.handle.includes("n")) y = clamp(y + dy, 0, y2 - 0.03);
        if (d.handle.includes("s")) y2 = clamp(y2 + dy, y + 0.03, 1);
        w = x2 - x;
        h = y2 - y;
      }
      onChange({ x, y, w, h });
    },
    [imgBox, onChange]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    setActive(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const box = {
    left: imgBox.left + value.x * imgBox.width,
    top: imgBox.top + value.y * imgBox.height,
    width: value.w * imgBox.width,
    height: value.h * imgBox.height,
  };

  const handleStyle: React.CSSProperties = {
    position: "absolute",
    width: 14,
    height: 14,
    background: "#fff",
    border: "2px solid var(--accent)",
    borderRadius: 3,
  };

  return (
    <div
      style={{ position: "absolute", inset: 0, cursor: active ? "grabbing" : "default" }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* dark mask outside crop */}
      <div
        style={{
          position: "absolute",
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          outline: "1px solid rgba(255,255,255,0.9)",
          cursor: "grab",
        }}
        onPointerDown={onPointerDown("move")}
      >
        {/* rule-of-thirds grid */}
        {[1, 2].map((i) => (
          <div key={"v" + i} style={{ position: "absolute", left: `${(i * 100) / 3}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.25)" }} />
        ))}
        {[1, 2].map((i) => (
          <div key={"h" + i} style={{ position: "absolute", top: `${(i * 100) / 3}%`, left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.25)" }} />
        ))}
      </div>
      {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
        <div
          key={h}
          onPointerDown={onPointerDown(h)}
          style={{
            ...handleStyle,
            left: h.includes("w") ? box.left - 7 : box.left + box.width - 7,
            top: h.includes("n") ? box.top - 7 : box.top + box.height - 7,
            cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
          }}
        />
      ))}
    </div>
  );
}
