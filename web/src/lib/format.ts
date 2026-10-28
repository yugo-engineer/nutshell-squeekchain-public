import { formatUnits } from "viem";

/** Renders a token amount, or null as the honest "not available". Never invents a zero. */
export function amt(v: bigint | null | undefined, dp = 4): string | null {
  if (v === null || v === undefined) return null;
  const n = Number(formatUnits(v, 18));
  if (n === 0) return "0";
  // Below 1, keep four significant digits so small (testnet-sized) amounts stay readable.
  if (n < 1) return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  return n.toLocaleString("en-US", { maximumFractionDigits: dp });
}

export const NA = "NOT AVAILABLE";
