import type { Metadata } from "next";
import { Geist, Martian_Mono, Syne } from "next/font/google";
import "./globals.css";

// The nutshell-fi type system: Syne for headlines and big numbers, Geist for prose, Martian Mono
// for the small tracked uppercase labels, data and buttons.
const display = Syne({ subsets: ["latin"], weight: ["400", "700", "800"], variable: "--font-display" });
const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Martian_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Nutshell — Liquidity, in a nutshell",
  description:
    "Protocol-owned liquidity for the Squeekchain ecosystem. Every LP fee splits at least 50% treasury, up to 35% Squeeks rewards in ETH, 15% buyback and burn.",
  icons: { icon: "/acorn-mark.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
