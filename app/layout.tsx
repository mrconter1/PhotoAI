import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PhotoAI",
  description: "A fast, desktop-first photo editor with AI edits.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
