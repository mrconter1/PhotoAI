"use client";

import { useCallback } from "react";
import type { CropRect } from "@/lib/image";

type Props = {
  // pixel rect of the displayed image within the stage (respects zoom/pan)
  imgBox: { left: number; top: number; width: number; height: number };
  value: CropRect;
  onChange: (r: CropRect) => void;
  ratio?: number | null; // locked w/h in normalized units; null/undefined = free
};

type Handle = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

const MIN = 0.03;

export default function CropOverlay({ imgBox, value, onChange, ratio }: Props) {
  // Drag handling via window listeners so the pointer can leave the image
  // (crop-out) and the empty stage keeps receiving pan/zoom events.
  const startDrag = useCallback(
    (handle: Handle) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = value;

      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / imgBox.width;
        const dy = (ev.clientY - startY) / imgBox.height;
        let { x, y, w, h } = start;

        if (handle === "move") {
          x = x + dx;
          y = y + dy;
        } else {
          let x2 = x + w;
          let y2 = y + h;
          if (handle.includes("w")) x = Math.min(x + dx, x2 - MIN);
          if (handle.includes("e")) x2 = Math.max(x2 + dx, x + MIN);
          if (handle.includes("n")) y = Math.min(y + dy, y2 - MIN);
          if (handle.includes("s")) y2 = Math.max(y2 + dy, y + MIN);

          if (ratio) {
            // keep locked aspect ratio while resizing
            const cxm = start.x + start.w / 2;
            const cym = start.y + start.h / 2;
            if (handle === "n" || handle === "s") {
              const nw = (y2 - y) * ratio;
              x = cxm - nw / 2;
              x2 = cxm + nw / 2;
            } else if (handle === "e" || handle === "w") {
              const nh = (x2 - x) / ratio;
              y = cym - nh / 2;
              y2 = cym + nh / 2;
            } else {
              // corner: derive height from width, anchored at the fixed corner
              const nh = (x2 - x) / ratio;
              if (handle.includes("n")) y = y2 - nh;
              else y2 = y + nh;
            }
          }
          w = x2 - x;
          h = y2 - y;
        }
        onChange({ x, y, w, h });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [imgBox, value, onChange]
  );

  const box = {
    left: imgBox.left + value.x * imgBox.width,
    top: imgBox.top + value.y * imgBox.height,
    width: value.w * imgBox.width,
    height: value.h * imgBox.height,
  };

  const handle = (h: Handle, cursor: string, left: number, top: number): React.CSSProperties => ({
    position: "absolute",
    left,
    top,
    width: 16,
    height: 16,
    marginLeft: -8,
    marginTop: -8,
    background: "#fff",
    border: "2px solid var(--accent)",
    borderRadius: 3,
    cursor,
    pointerEvents: "auto",
    boxShadow: "0 1px 4px rgba(0,0,0,0.6)",
  });

  const edges: [Handle, string, number, number][] = [
    ["nw", "nwse-resize", box.left, box.top],
    ["ne", "nesw-resize", box.left + box.width, box.top],
    ["sw", "nesw-resize", box.left, box.top + box.height],
    ["se", "nwse-resize", box.left + box.width, box.top + box.height],
    ["n", "ns-resize", box.left + box.width / 2, box.top],
    ["s", "ns-resize", box.left + box.width / 2, box.top + box.height],
    ["w", "ew-resize", box.left, box.top + box.height / 2],
    ["e", "ew-resize", box.left + box.width, box.top + box.height / 2],
  ];

  return (
    // root ignores pointer events so panning/zoom on empty stage still works
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* dim everything outside the crop */}
      <div
        style={{
          position: "absolute",
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)",
          outline: "2px solid #fff",
          cursor: "move",
          pointerEvents: "auto",
        }}
        onPointerDown={startDrag("move")}
      >
        {[1, 2].map((i) => (
          <div key={"v" + i} style={{ position: "absolute", left: `${(i * 100) / 3}%`, top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.35)" }} />
        ))}
        {[1, 2].map((i) => (
          <div key={"h" + i} style={{ position: "absolute", top: `${(i * 100) / 3}%`, left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.35)" }} />
        ))}
      </div>
      {edges.map(([h, cursor, l, t]) => (
        <div key={h} onPointerDown={startDrag(h)} style={handle(h, cursor, l, t)} />
      ))}
    </div>
  );
}
