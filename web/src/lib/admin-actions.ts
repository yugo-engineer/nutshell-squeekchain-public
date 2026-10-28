/**
 * Every write /admin can send, as data. One form renders any of them: the field types below
 * decide the input and how its text becomes a call argument. The contracts enforce who may call
 * what - `who` only decides whether the action is offered to the connected wallet.
 */
import { isAddress, parseEther, parseUnits, type Hex } from "viem";
import { CONFIG } from "./config";
import { ADDR_KEYS, CFG_KEYS, k32, type Pool, type PoolKey } from "./admin";

export type FieldT = "uint" | "amount" | "int" | "addr" | "bytes32" | "pool" | "token" | "bool" | "bucket" | "cfgKey" | "ids" | "usd";
export type Field = { n: string; t: FieldT; hint?: string };
export type Who = "owner" | "operator" | "anyone" | "pending";
export type Ctx = { pools: Pool[]; tokens: Hex[] };
export type Action = {
  id: string;
  c: "hub" | "sale";
  fn: string;
  label: string;
  who: Who;
  fields: Field[];
  /** Builds the call's args from the form; default converts each field in order. */
  args?: (v: Record<string, string>, ctx: Ctx) => unknown[];
  /** Shown before sending; for anything that cannot be undone. */
  warn?: string;
};

const P = CONFIG.ADMIN.PRESALE;
const ADDR_KEY_SET = new Set(ADDR_KEYS.map(([k]) => k));

export const ACTIONS: Action[] = [
  // ---- positions
  { id: "open", c: "hub", fn: "openPosition", label: "Open position", who: "operator", fields: [{ n: "pool", t: "pool" }, { n: "tickLower", t: "int" }, { n: "tickUpper", t: "int" }, { n: "liquidity", t: "uint", hint: "raw L" }, { n: "amount0Max", t: "amount" }, { n: "amount1Max", t: "amount" }] },
  { id: "increase", c: "hub", fn: "increasePosition", label: "Increase position", who: "operator", fields: [{ n: "tokenId", t: "uint" }, { n: "liquidity", t: "uint", hint: "raw L" }, { n: "amount0Max", t: "amount" }, { n: "amount1Max", t: "amount" }] },
  { id: "decrease", c: "hub", fn: "decreasePosition", label: "Decrease position", who: "operator", fields: [{ n: "tokenId", t: "uint" }, { n: "liquidity", t: "uint", hint: "raw L" }, { n: "amount0Min", t: "amount" }, { n: "amount1Min", t: "amount" }] },
  { id: "close", c: "hub", fn: "closePosition", label: "Close position", who: "operator", fields: [{ n: "tokenId", t: "uint" }, { n: "amount0Min", t: "amount" }, { n: "amount1Min", t: "amount" }], warn: "Removes all liquidity and burns the position NFT." },
  { id: "collect", c: "hub", fn: "collectFees", label: "Collect fees", who: "anyone", fields: [{ n: "tokenIds", t: "ids", hint: "comma separated" }] },

  // ---- buckets + treasury
  { id: "swapBucket", c: "hub", fn: "swapBucket", label: "Swap bucket", who: "operator", fields: [{ n: "bucket", t: "bucket" }, { n: "pool", t: "pool" }, { n: "zeroForOne", t: "bool", hint: "true = sell currency0" }, { n: "amountIn", t: "amount" }, { n: "minOut", t: "amount", hint: "from a fresh quote" }] },
  { id: "swapTreasury", c: "hub", fn: "swapTreasury", label: "Swap treasury", who: "operator", fields: [{ n: "pool", t: "pool" }, { n: "zeroForOne", t: "bool", hint: "true = sell currency0" }, { n: "amountIn", t: "amount" }, { n: "minOut", t: "amount", hint: "from a fresh quote" }] },
  { id: "sweepRewards", c: "hub", fn: "sweepRewards", label: "Sweep rewards to treasury", who: "operator", fields: [{ n: "token", t: "token" }, { n: "amount", t: "amount" }] },
  { id: "withdraw", c: "hub", fn: "withdraw", label: "Withdraw free capital", who: "owner", fields: [{ n: "token", t: "token" }, { n: "to", t: "addr" }, { n: "amount", t: "amount" }] },

  // ---- config + pools
  {
    id: "setCfg", c: "hub", fn: "setCfg", label: "Set config key", who: "operator", fields: [{ n: "key", t: "cfgKey" }, { n: "value", t: "uint", hint: "address keys take 0x…" }],
    args: (v) => [[k32(v.key)], [BigInt(v.value)]],
  },
  {
    id: "setPool", c: "hub", fn: "setPools", label: "Allowlist pool", who: "operator", fields: [{ n: "pool", t: "pool" }, { n: "allowed", t: "bool" }],
    args: (v, ctx) => [[poolOf(v.pool, ctx)], [v.allowed === "true"]],
  },

  // ---- epochs
  { id: "postEpoch", c: "hub", fn: "postEpoch", label: "Post epoch", who: "operator", fields: [{ n: "root", t: "bytes32" }, { n: "total", t: "amount", hint: "ETH" }, { n: "snapshotBlock", t: "uint" }], warn: "Publish the epoch JSON and redeploy the site first." },
  { id: "cancelEpoch", c: "hub", fn: "cancelEpoch", label: "Cancel epoch", who: "operator", fields: [{ n: "epochId", t: "uint" }] },
  { id: "closeEpoch", c: "hub", fn: "closeEpoch", label: "Close expired epoch", who: "anyone", fields: [{ n: "epochId", t: "uint" }] },

  // ---- hub ownership
  { id: "hubTransfer", c: "hub", fn: "transferOwnership", label: "Transfer hub ownership", who: "owner", fields: [{ n: "to", t: "addr" }], warn: "The new owner must call acceptOwnership." },
  { id: "hubAccept", c: "hub", fn: "acceptOwnership", label: "Accept hub ownership", who: "pending", fields: [] },

  // ---- presale
  {
    id: "configure", c: "sale", fn: "configure", label: "Push presale terms", who: "operator", fields: [],
    args: () => [P.SUPPLY, P.FDV_USD, P.MIN_USD, P.MAX_USD, P.P1_CAP, P.P2_CAP, P.P1_DURATION, P.P2_DURATION],
  },
  { id: "rate", c: "sale", fn: "setEthUsd", label: "Set ETH/USD rate", who: "operator", fields: [{ n: "usdPerEth", t: "usd" }] },
  { id: "root", c: "sale", fn: "setWhitelistRoot", label: "Set whitelist root", who: "operator", fields: [{ n: "root", t: "bytes32", hint: "from npm run presale -- whitelist" }] },
  { id: "start", c: "sale", fn: "startPhase1", label: "Start phase 1", who: "operator", fields: [], warn: "Opens phase 1 now. Terms freeze; phase 2 follows by itself. Cannot be undone." },
  { id: "openClaims", c: "sale", fn: "openClaims", label: "Open TGE claims", who: "operator", fields: [{ n: "token", t: "addr" }], warn: "Fund the presale with the sold tokens first." },
  { id: "saleSweep", c: "sale", fn: "sweep", label: "Sweep presale surplus", who: "operator", fields: [{ n: "token", t: "addr" }] },
  { id: "saleOperator", c: "sale", fn: "setOperator", label: "Set presale operator", who: "owner", fields: [{ n: "operator", t: "addr" }] },
  { id: "saleTreasury", c: "sale", fn: "setTreasury", label: "Set presale treasury", who: "owner", fields: [{ n: "treasury", t: "addr" }], warn: "Every presale wei goes here." },
  { id: "saleTransfer", c: "sale", fn: "transferOwnership", label: "Transfer presale ownership", who: "owner", fields: [{ n: "to", t: "addr" }] },
  { id: "saleAccept", c: "sale", fn: "acceptOwnership", label: "Accept presale ownership", who: "pending", fields: [] },
];

export const actionById = (id: string) => ACTIONS.find((a) => a.id === id)!;
export const cfgKeyOptions = [...CFG_KEYS, ...ADDR_KEY_SET];
export const isOwnerKey = (k: string) => ADDR_KEY_SET.has(k);

function poolOf(id: string, ctx: Ctx): PoolKey {
  const p = ctx.pools.find((x) => x.poolId === id);
  if (!p) throw new Error("Pick a pool");
  return p.key;
}

/** Form text -> call args. Throws a readable message on bad input. */
export function buildArgs(a: Action, v: Record<string, string>, ctx: Ctx): unknown[] {
  for (const f of a.fields) if (!v[f.n]?.trim()) throw new Error(`${f.n} is required`);
  if (a.args) return a.args(v, ctx);
  return a.fields.map((f) => {
    const s = v[f.n].trim();
    switch (f.t) {
      case "uint": return BigInt(s);
      case "int": return Number.parseInt(s, 10);
      case "amount": return parseEther(s);
      case "usd": return parseUnits(s, 8);
      case "bool": return s === "true";
      case "bucket": return Number(s);
      case "ids": return s.split(/[\s,]+/).filter(Boolean).map(BigInt);
      case "pool": return poolOf(s, ctx);
      case "addr":
      case "token":
        if (!isAddress(s)) throw new Error(`${f.n} is not an address`);
        return s;
      case "bytes32":
        if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error(`${f.n} must be 32 bytes of hex`);
        return s;
      default: return s;
    }
  });
}
