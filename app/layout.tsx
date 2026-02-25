import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Labs WebXR (Splats Day One)",
  description: "Generate Marble worlds from text prompts and explore them in WebXR with SPZ splats.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
