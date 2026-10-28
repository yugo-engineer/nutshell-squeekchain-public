"use client";
/**
 * One poll of everything the public page shows, straight from the hub. Every number is either a
 * value read on chain or `null` - the UI renders null as "not available", never as zero.
 */
import { useEffect, useState } from "react";
import { stringToHex, type Hex } from "viem";
import { CONFIG } from "./config";
import { ERC20_ABI, ETH, HUB, NUTS, publicClient } from "./chain";
import { NUTSHELL_ABI } from "./nutshell-abi";

export type Burn = { tx: Hex; block: bigint; amount: bigint; supplyAfter: bigint };
export type EpochRow = {
  id: number;
  root: Hex;
  total: bigint;
  claimed: bigint;
  snapshotBlock: bigint;
  claimableAt: number;
  expiresAt: number;
  closed: boolean;
};

export type Protocol = {
  deployed: boolean;
  error: string | null;
  loading: boolean;
  feesEth: bigint | null;
  feesNuts: bigint | null;
  treasuryEth: bigint | null;
  freeEth: bigint | null;
  rewardsEth: bigint | null;
  buybackEth: bigint | null;
  epochReserved: bigint | null;
  rewardsPaid: bigint | null;
  nutsBurned: bigint | null;
  nutsSupply: bigint | null;
  positions: number | null;
  poolLive: boolean | null;
  /** The live revenue split, in percent, read from the hub's config. */
  split: { treasury: number; rewards: number; buyback: number } | null;
  epochs: EpochRow[];
  burns: Burn[];
};

const EMPTY: Protocol = {
  deployed: !!HUB,
  error: null,
  loading: !!HUB,
  feesEth: null,
  feesNuts: null,
  treasuryEth: null,
  freeEth: null,
  rewardsEth: null,
  buybackEth: null,
  epochReserved: null,
  rewardsPaid: null,
  nutsBurned: null,
  nutsSupply: null,
  positions: null,
  poolLive: null,
  split: null,
  epochs: [],
  burns: [],
};

const burnedEvent = NUTSHELL_ABI.find((x) => x.type === "event" && x.name === "TokensBurned")!;
const LOG_CHUNK = 5_000n;
type MC = { status: "success" | "failure"; result?: unknown }[];

async function load(): Promise<Protocol> {
  if (!HUB) return { ...EMPTY, loading: false };
  const r = (functionName: string, args: unknown[] = []) =>
    ({ address: HUB, abi: NUTSHELL_ABI, functionName, args }) as const;

  const res = (await publicClient.multicall({
    contracts: [
      r("feesCollected", [ETH]),
      r("feesCollected", [NUTS ?? ETH]),
      r("treasuryRetained", [ETH]),
      r("freeBalance", [ETH]),
      r("rewardsBal", [ETH]),
      r("buybackBal", [ETH]),
      r("epochReserved"),
      r("rewardsPaid"),
      r("nutsBurned"),
      r("positionCount"),
      r("epochCount"),
      r("cfg", [stringToHex("rewardsBps", { size: 32 })]),
      r("cfg", [stringToHex("buybackBps", { size: 32 })]),
      ...(NUTS ? [{ address: NUTS, abi: ERC20_ABI, functionName: "totalSupply" } as const] : []),
    ] as never,
    allowFailure: true,
  })) as unknown as MC;
  const v = (i: number) => (res[i]?.status === "success" ? (res[i].result as bigint) : null);

  const epochCount = Number(v(10) ?? 0n);
  const epochRes = epochCount
    ? ((await publicClient.multicall({
        contracts: Array.from({ length: epochCount }, (_, i) => r("epoch", [BigInt(i)])) as never,
        allowFailure: true,
      })) as unknown as MC)
    : [];
  const epochs: EpochRow[] = epochRes.flatMap((e, i) => {
    if (e.status !== "success") return [];
    const x = e.result as { root: Hex; total: bigint; claimed: bigint; snapshotBlock: bigint; claimableAt: bigint; expiresAt: bigint; closed: boolean };
    return [{ id: i, root: x.root, total: x.total, claimed: x.claimed, snapshotBlock: x.snapshotBlock, claimableAt: Number(x.claimableAt), expiresAt: Number(x.expiresAt), closed: x.closed }];
  });

  // Burns: TokensBurned since the deploy block, in chunks a public node accepts.
  const burns: Burn[] = [];
  try {
    const head = await publicClient.getBlockNumber();
    for (let from = BigInt(CONFIG.DEPLOY_BLOCK); from <= head; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
      const logs = await publicClient.getLogs({ address: HUB, event: burnedEvent as never, fromBlock: from, toBlock: to });
      type BurnLog = { transactionHash: Hex; blockNumber: bigint; args: { amount: bigint; totalSupplyAfter: bigint } };
      for (const l of logs as unknown as BurnLog[]) {
        burns.push({ tx: l.transactionHash, block: l.blockNumber, amount: l.args.amount, supplyAfter: l.args.totalSupplyAfter });
      }
    }
  } catch {
    /* history is best-effort; the totals above still come from contract state */
  }

  const positions = v(9);
  return {
    deployed: true,
    error: null,
    loading: false,
    feesEth: v(0),
    feesNuts: NUTS ? v(1) : null,
    treasuryEth: v(2),
    freeEth: v(3),
    rewardsEth: v(4),
    buybackEth: v(5),
    epochReserved: v(6),
    rewardsPaid: v(7),
    nutsBurned: v(8),
    nutsSupply: NUTS ? v(13) : null,
    split:
      v(11) === null || v(12) === null
        ? null
        : { rewards: Number(v(11)) / 100, buyback: Number(v(12)) / 100, treasury: 100 - Number(v(11)) / 100 - Number(v(12)) / 100 },
    positions: positions === null ? null : Number(positions),
    poolLive: positions === null ? null : positions > 0n,
    epochs,
    burns: burns.reverse(),
  };
}

export function useProtocol(intervalMs = 20_000): Protocol & { refresh: () => void } {
  const [state, setState] = useState<Protocol>(EMPTY);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      load()
        .then((p) => alive && setState(p))
        .catch((e) => alive && setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })));
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
