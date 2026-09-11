// Styles shared between the workspace (tabs, open, close) and the editor.

export const hint: React.CSSProperties = { fontSize: 12, color: "var(--muted)", margin: 0, lineHeight: 1.5 };

export const dropOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 150,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(14,14,17,0.72)",
  backdropFilter: "blur(2px)",
  pointerEvents: "none", // the drop still has to reach the page underneath
};
export const dropCard: React.CSSProperties = {
  textAlign: "center",
  padding: "26px 34px",
  borderRadius: 16,
  border: "2px dashed var(--accent)",
  background: "rgba(30,30,37,0.9)",
  boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
};
export const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};
export const modalCard: React.CSSProperties = {
  width: "min(420px, calc(100% - 32px))",
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 22,
  boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
};
