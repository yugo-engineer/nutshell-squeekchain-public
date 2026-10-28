import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Genesis presale — Nutshell",
  description:
    "The Nutshell Genesis presale: two one-hour phases, Squeeks holders first, $500 to $3,500 per wallet in ETH, 100% claimable at TGE.",
};

export default function PresaleLayout({ children }: { children: React.ReactNode }) {
  return children;
}
