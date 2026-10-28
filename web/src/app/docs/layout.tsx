import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs — Nutshell",
  description:
    "How Nutshell works: protocol-owned Uniswap v4 liquidity, the constant 50 / 30 / 20 fee split, Squeeks reward epochs, buyback and burn, and how to verify all of it on chain.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
