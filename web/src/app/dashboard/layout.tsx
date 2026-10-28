import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard — Nutshell",
  description: "Live Nutshell hub state: fees collected, treasury, Squeeks rewards paid, buckets and the burn log.",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
