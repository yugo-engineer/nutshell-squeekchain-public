"use client";
/**
 * /admin data: one load of everything the operator looks at - pools and live positions (with
 * uncollected fees from StateView), buckets, cfg vs the desired state in CONFIG.ADMIN, epochs,
 * roles, and the presale with its buyers. Same rule as the public page: a failed read is null,
 * never zero.
 */
import { encodeAbiParameters, keccak256, numberToHex, parseAbi, stringToHex, type Hex } from "viem";
import { CONFIG } from "./config";
import { ETH, HUB, NUTS, publicClient } from "./chain";
import { NUTSHELL_ABI } from "./nutshell-abi";
import { PRESALE_ABI } from "./presale-abi";
import type { EpochRow } from "./useProtocol";

export const SALE = (CONFIG.PRESALE_ADDRESS || null) as Hex | null;
const A = CONFIG.ADMIN;

export const k32 = (s: string) => stringToHex(s, { size: 32 });
/** Every economic key. The operator may set exactly these; address keys are owner-only. */
export const CFG_KEYS = Object.keys(A.CHAIN_CFG);
export const ADDR_KEYS: [key: string, want: string | null][] = [
  ["operator", null],
  ["nuts", CONFIG.NUTS_ADDRESS],
  ["squeekNft", CONFIG.SQUEEK_NFT_ADDRESS],
  ["positionManager", A.POSITION_MANAGER],
  ["permit2", A.PERMIT2],
  ["swapAdapter", A.SWAP_ADAPTER_ADDRESS],
];

export type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };

const POSM_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Same rule as scripts/chain.ts poolKey(): base defaults to NUTS, native ETH sorts first. */
export function poolKey(p: (typeof A.POOLS)[number]): PoolKey | null {
  const base = (p.base ?? NUTS) as Hex | null;
  if (!base) return null;
  const other = (p.pair === "ETH" ? ETH : p.pair) as Hex;
  const [currency0, currency1] = BigInt(other) < BigInt(base) ? [other, base] : [base, other];
  return { currency0, currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: (p.hooks ?? ETH) as Hex };
}
export const poolIdOf = (k: PoolKey) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]
    )
  );

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const sym = (t: string) => (same(t, ETH) ? "ETH" : same(t, NUTS) ? "NUTS" : `${t.slice(0, 6)}…${t.slice(-4)}`);
export const pairLabel = (k: PoolKey) => `${sym(k.currency0)}/${sym(k.currency1)} ${(k.fee / 10_000).toFixed(2)}%${same(k.hooks, ETH) ? "" : " · hooked"}`;

export type Pool = {
  id: string; // config id, or the short PoolId for a pool only seen through a position
  key: PoolKey;
  poolId: Hex;
  want: boolean | null; // allowed in CONFIG.ADMIN.POOLS; null = not in config
  allowed: boolean | null;
  tick: number | null;
  /** currency1 per currency0, both 18 decimals. */
  price: number | null;
  liquidity: bigint | null;
};
export type Position = {
  tokenId: bigint;
  key: PoolKey;
  live: boolean;
  tickLower: number | null;
  tickUpper: number | null;
  liquidity: bigint | null;
  fees0: bigint | null;
  fees1: bigint | null;
  inRange: boolean | null;
};
export type Bucket = { token: Hex; balance: bigint | null; free: bigint | null; rewards: bigint | null; buyback: bigint | null; fees: bigint | null; retained: bigint | null };
export type AddrRow = { label: string; value: Hex | null; want: string | null; hasCode: boolean | null };
export type Buyer = { address: Hex; paid: bigint; usd: bigint; tokens: bigint; phases: number[]; owed: bigint | null };
export type Sale = {
  owner: Hex; pendingOwner: Hex; operator: Hex; treasury: Hex; token: Hex;
  phase: number; phaseStart: number; phaseEnd: number; cap: bigint; sold: bigint; raised: bigint; rate: bigint;
  start: number; p1Sold: bigint; p2Sold: bigint; totalOwed: bigint; root: Hex; claimsOpen: boolean;
  terms: { supply: bigint; fdvUsd: bigint; minUsd: bigint; maxUsd: bigint; p1Cap: bigint; p2Cap: bigint; p1Duration: bigint; p2Duration: bigint };
  termsMatch: boolean;
  tokenBal: bigint | null;
  /** undefined = not scanned yet, null = the scan failed. */
  buyers?: Buyer[] | null;
};
export type Admin = {
  at: number;
  owner: Hex;
  pendingOwner: Hex;
  operator: Hex;
  cfg: { key: string; chain: bigint | null; want: bigint }[];
  addrs: AddrRow[];
  pools: Pool[];
  positions: Position[];
  buckets: Bucket[];
  epochReserved: bigint | null;
  rewardsPaid: bigint | null;
  nutsBurned: bigint | null;
  nutsSupply: bigint | null;
  epochs: EpochRow[];
  sale: Sale | null;
};

type MC = { status: "success" | "failure"; result?: unknown }[];
const multi = async (contracts: unknown[]) =>
  contracts.length ? ((await publicClient.multicall({ contracts: contracts as never, allowFailure: true })) as unknown as MC) : [];
const ok = <T,>(r: MC[number] | undefined) => (r?.status === "success" ? (r.result as T) : null);
const hub = (functionName: string, args: unknown[] = []) => ({ address: HUB!, abi: NUTSHELL_ABI, functionName, args });
const sale = (functionName: string, args: unknown[] = []) => ({ address: SALE!, abi: PRESALE_ABI, functionName, args });
const toAddr = (v: bigint | null) => (v === null ? null : (numberToHex(v, { size: 20 }) as Hex));
/** int24 at bit `shift` of a v4 PositionInfo word. */
const int24 = (info: bigint, shift: bigint) => {
  const v = Number((info >> shift) & 0xffffffn);
  return v >= 0x800000 ? v - 0x1000000 : v;
};
const Q128 = 1n << 128n;
const M256 = (1n << 256n) - 1n;

export async function loadAdmin(withBuyers: boolean): Promise<Admin> {
  if (!HUB) throw new Error("Hub not deployed");

  // ---- 1: hub basics + presale scalars
  const SALE_FIELDS = ["owner", "pendingOwner", "operator", "treasury", "token", "status", "start", "p1Sold", "p2Sold", "totalOwed", "whitelistRoot", "claimsOpen", "totalSupplyTokens", "fdvUsd", "minUsd", "maxUsd", "p1Cap", "p2Cap", "p1Duration", "p2Duration"] as const;
  const r1 = await multi([
    hub("owner"), hub("pendingOwner"), hub("getCfg", [[...CFG_KEYS, ...ADDR_KEYS.map(([k]) => k)].map(k32)]),
    hub("positionCount"), hub("epochCount"), hub("epochReserved"), hub("rewardsPaid"), hub("nutsBurned"),
    ...(NUTS ? [{ address: NUTS, abi: parseAbi(["function totalSupply() view returns (uint256)"]), functionName: "totalSupply" }] : []),
    ...(SALE ? SALE_FIELDS.map((f) => sale(f)) : []),
  ]);
  const cfgVals = ok<readonly bigint[]>(r1[2]);
  const nPos = Number(ok<bigint>(r1[3]) ?? 0n);
  const nEpochs = Number(ok<bigint>(r1[4]) ?? 0n);
  const saleAt = NUTS ? 9 : 8;
  const s = Object.fromEntries(SALE_FIELDS.map((f, i) => [f, ok<unknown>(r1[saleAt + i])])) as Record<(typeof SALE_FIELDS)[number], unknown>;

  const addrVals = ADDR_KEYS.map((_, i) => toAddr(cfgVals ? cfgVals[CFG_KEYS.length + i] : null));

  // ---- 2: positions, pools, buckets, epochs, code checks
  const cfgPools = A.POOLS.flatMap((p) => {
    const key = poolKey(p);
    return key ? [{ id: p.id, key, want: p.allowed }] : [];
  });
  const tokens = [ETH, ...(NUTS ? [NUTS] : [])] as Hex[];
  for (const p of cfgPools) for (const t of [p.key.currency0, p.key.currency1]) if (!tokens.some((x) => same(x, t))) tokens.push(t);

  const ids = (await multi(Array.from({ length: nPos }, (_, i) => hub("positionIds", [BigInt(i)])))).map((r) => ok<bigint>(r) ?? 0n);
  const r2 = await multi([
    ...ids.map((id) => hub("position", [id])),
    ...Array.from({ length: nEpochs }, (_, i) => hub("epoch", [BigInt(i)])),
    ...tokens.flatMap((t) => [hub("freeBalance", [t]), hub("rewardsBal", [t]), hub("buybackBal", [t]), hub("feesCollected", [t]), hub("treasuryRetained", [t])]),
    ...tokens.filter((t) => !same(t, ETH)).map((t) => ({ address: t, abi: ERC20, functionName: "balanceOf", args: [HUB] })),
  ]);
  let i = 0;
  const positionsRaw = ids.map((tokenId) => {
    const r = ok<readonly [PoolKey, boolean]>(r2[i++]);
    return { tokenId, key: r?.[0] ?? null, live: r?.[1] ?? false };
  });
  const epochs: EpochRow[] = [];
  for (let e = 0; e < nEpochs; e++) {
    const x = ok<{ root: Hex; total: bigint; claimed: bigint; snapshotBlock: bigint; claimableAt: bigint; expiresAt: bigint; closed: boolean }>(r2[i++]);
    if (x) epochs.push({ id: e, root: x.root, total: x.total, claimed: x.claimed, snapshotBlock: x.snapshotBlock, claimableAt: Number(x.claimableAt), expiresAt: Number(x.expiresAt), closed: x.closed });
  }
  const bucketVals = tokens.map(() => [0, 1, 2, 3, 4].map(() => ok<bigint>(r2[i++])));
  const erc20Bal = new Map(tokens.filter((t) => !same(t, ETH)).map((t) => [t, ok<bigint>(r2[i++])]));

  // every pool we care about: config's, plus any a position sits in
  const pools: Pool[] = cfgPools.map((p) => ({ ...p, poolId: poolIdOf(p.key), allowed: null, tick: null, price: null, liquidity: null }));
  for (const p of positionsRaw) {
    if (!p.key) continue;
    const id = poolIdOf(p.key);
    if (!pools.some((x) => x.poolId === id)) pools.push({ id: `${id.slice(0, 10)}…`, key: p.key, poolId: id, want: null, allowed: null, tick: null, price: null, liquidity: null });
  }

  const live = positionsRaw.filter((p) => p.live && p.key);
  const r3 = await multi([
    ...pools.flatMap((p) => [hub("poolAllowed", [p.poolId]), { address: A.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [p.poolId] }, { address: A.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [p.poolId] }]),
    ...live.flatMap((p) => [
      { address: A.POSITION_MANAGER, abi: POSM_ABI, functionName: "getPoolAndPositionInfo", args: [p.tokenId] },
      { address: A.POSITION_MANAGER, abi: POSM_ABI, functionName: "getPositionLiquidity", args: [p.tokenId] },
    ]),
  ]);
  const [ethBal, codes] = await Promise.all([
    publicClient.getBalance({ address: HUB }).catch(() => null),
    Promise.all(addrVals.map((a) => (a && BigInt(a) !== 0n ? publicClient.getCode({ address: a }).then((c) => !!c && c !== "0x").catch(() => null) : Promise.resolve(null)))),
  ]);
  i = 0;
  for (const p of pools) {
    p.allowed = ok<boolean>(r3[i++]);
    const slot0 = ok<readonly [bigint, number, number, number]>(r3[i++]);
    p.liquidity = ok<bigint>(r3[i++]);
    if (slot0 && slot0[0] !== 0n) {
      p.tick = slot0[1];
      p.price = (Number(slot0[0]) / 2 ** 96) ** 2;
    }
  }
  const ranges = live.map((p) => {
    const info = ok<readonly [PoolKey, bigint]>(r3[i++]);
    const liq = ok<bigint>(r3[i++]);
    return { tokenId: p.tokenId, tickLower: info ? int24(info[1], 8n) : null, tickUpper: info ? int24(info[1], 32n) : null, liquidity: liq };
  });

  // ---- 3: uncollected fees = (feeGrowthInside - last) * liquidity / 2^128, wrapping like v4
  const withRange = ranges.filter((r) => r.tickLower !== null && r.tickUpper !== null);
  const r4 = await multi(
    withRange.flatMap((r) => {
      const key = live.find((p) => p.tokenId === r.tokenId)!.key!;
      const id = poolIdOf(key);
      return [
        { address: A.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getPositionInfo", args: [id, A.POSITION_MANAGER, r.tickLower, r.tickUpper, numberToHex(r.tokenId, { size: 32 })] },
        { address: A.STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getFeeGrowthInside", args: [id, r.tickLower, r.tickUpper] },
      ];
    })
  );
  const fees = new Map<bigint, [bigint | null, bigint | null]>();
  withRange.forEach((r, j) => {
    const last = ok<readonly [bigint, bigint, bigint]>(r4[j * 2]);
    const now = ok<readonly [bigint, bigint]>(r4[j * 2 + 1]);
    if (!last || !now) return fees.set(r.tokenId, [null, null]);
    const owed = (a: bigint, b: bigint) => (((a - b) & M256) * last[0]) / Q128;
    fees.set(r.tokenId, [owed(now[0], last[1]), owed(now[1], last[2])]);
  });

  const positions: Position[] = positionsRaw.flatMap((p) => {
    if (!p.key) return [];
    const r = ranges.find((x) => x.tokenId === p.tokenId);
    const pool = pools.find((x) => x.poolId === poolIdOf(p.key!));
    const tl = r?.tickLower ?? null;
    const tu = r?.tickUpper ?? null;
    return [{
      tokenId: p.tokenId, key: p.key, live: p.live, tickLower: tl, tickUpper: tu,
      liquidity: p.live ? r?.liquidity ?? null : 0n,
      fees0: fees.get(p.tokenId)?.[0] ?? null, fees1: fees.get(p.tokenId)?.[1] ?? null,
      inRange: pool?.tick == null || tl === null || tu === null ? null : pool.tick >= tl && pool.tick < tu,
    }];
  });

  const buckets: Bucket[] = tokens.map((t, j) => {
    const [free, rewards, buyback, fees_, retained] = bucketVals[j];
    return { token: t, balance: same(t, ETH) ? ethBal : erc20Bal.get(t) ?? null, free, rewards, buyback, fees: fees_, retained };
  });

  // ---- 4: presale
  let saleOut: Sale | null = null;
  if (SALE && s.status) {
    const st = s.status as readonly [number, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    const terms = {
      supply: s.totalSupplyTokens as bigint, fdvUsd: s.fdvUsd as bigint, minUsd: s.minUsd as bigint, maxUsd: s.maxUsd as bigint,
      p1Cap: s.p1Cap as bigint, p2Cap: s.p2Cap as bigint, p1Duration: BigInt(s.p1Duration as bigint), p2Duration: BigInt(s.p2Duration as bigint),
    };
    const P = A.PRESALE;
    const token = s.token as Hex;
    const tokenBal = token && BigInt(token) !== 0n
      ? await publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [SALE] }).catch(() => null)
      : NUTS ? await publicClient.readContract({ address: NUTS, abi: ERC20, functionName: "balanceOf", args: [SALE] }).catch(() => null) : null;
    saleOut = {
      owner: s.owner as Hex, pendingOwner: s.pendingOwner as Hex, operator: s.operator as Hex, treasury: s.treasury as Hex, token,
      phase: Number(st[0]), phaseStart: Number(st[1]), phaseEnd: Number(st[2]), cap: st[3], sold: st[4], raised: st[5], rate: st[6],
      start: Number(s.start as bigint), p1Sold: s.p1Sold as bigint, p2Sold: s.p2Sold as bigint, totalOwed: s.totalOwed as bigint,
      root: s.whitelistRoot as Hex, claimsOpen: s.claimsOpen as boolean, terms,
      termsMatch: terms.supply === P.SUPPLY && terms.fdvUsd === P.FDV_USD && terms.minUsd === P.MIN_USD && terms.maxUsd === P.MAX_USD
        && terms.p1Cap === P.P1_CAP && terms.p2Cap === P.P2_CAP && terms.p1Duration === P.P1_DURATION && terms.p2Duration === P.P2_DURATION,
      tokenBal,
      buyers: Number(s.start as bigint) === 0 ? [] : withBuyers ? await loadBuyers() : undefined,
    };
  }

  return {
    at: Date.now(),
    owner: ok<Hex>(r1[0])!,
    pendingOwner: ok<Hex>(r1[1])!,
    operator: addrVals[0] ?? ETH,
    cfg: CFG_KEYS.map((key, j) => ({ key, chain: cfgVals ? cfgVals[j] : null, want: A.CHAIN_CFG[key] })),
    addrs: ADDR_KEYS.map(([label, want], j) => ({ label, value: addrVals[j], want, hasCode: codes[j] })),
    pools,
    positions,
    buckets,
    epochReserved: ok<bigint>(r1[5]),
    rewardsPaid: ok<bigint>(r1[6]),
    nutsBurned: ok<bigint>(r1[7]),
    nutsSupply: NUTS ? ok<bigint>(r1[8]) : null,
    epochs,
    sale: saleOut,
  };
}

const boughtEvent = PRESALE_ABI.find((x) => x.type === "event" && x.name === "Bought")!;
const LOG_CHUNK = 5_000n;

/** publicnode load-balances across nodes and some answer "pruned history unavailable" for a
 *  range another node serves fine (measured 2026-10-27), so a chunk gets a few tries. */
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (e) {
      if (n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 400 * n));
    }
  }
}

/** Every Bought event since the deploy block, summed per wallet, plus what each is still owed. */
async function loadBuyers(): Promise<Buyer[] | null> {
  try {
    const head = await publicClient.getBlockNumber();
    const by = new Map<string, Buyer>();
    for (let from = BigInt(CONFIG.DEPLOY_BLOCK); from <= head; from += LOG_CHUNK) {
      const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
      const logs = await retry(() => publicClient.getLogs({ address: SALE!, event: boughtEvent as never, fromBlock: from, toBlock: to }));
      type L = { args: { buyer: Hex; phase: number; paidWei: bigint; usd: bigint; tokens: bigint } };
      for (const { args: a } of logs as unknown as L[]) {
        const b = by.get(a.buyer) ?? { address: a.buyer, paid: 0n, usd: 0n, tokens: 0n, phases: [], owed: null };
        b.paid += a.paidWei;
        b.usd += a.usd;
        b.tokens += a.tokens;
        if (!b.phases.includes(Number(a.phase))) b.phases.push(Number(a.phase));
        by.set(a.buyer, b);
      }
    }
    const list = [...by.values()].sort((a, b) => (b.tokens > a.tokens ? 1 : -1));
    const owed = await multi(list.map((b) => sale("owed", [b.address])));
    list.forEach((b, j) => (b.owed = ok<bigint>(owed[j])));
    return list;
  } catch (e) {
    console.warn("presale buyers scan failed", e);
    return null;
  }
}
