import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Squeeks rewards — Nutshell",
  description: "Claim the ETH your Squeeks earned from Nutshell LP fees, epoch by epoch.",
};

export default function RewardsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
