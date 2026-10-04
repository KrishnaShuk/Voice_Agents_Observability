import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "voxobs — voice agent observability",
  description: "Provider-level latency attribution and failover for voice agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
