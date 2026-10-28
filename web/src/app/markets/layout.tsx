import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Markets — Nutshell",
  description: "The live Nutshell market on Uniswap v4 and the stock-token pairs under research.",
};

export default function MarketsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
