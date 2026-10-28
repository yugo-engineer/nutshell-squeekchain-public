/**
 * Pushes server/config.ts onto the chain, writing only what differs.
 *
 *   npm run config:push:dry    # show the diff only
 *   npm run config:push        # show the diff and apply it
 *
 * Two things are desired state:
 *   1. the cfg map - CHAIN_CFG plus the addresses the hub reads (operator, nuts, squeekNft,
 *      positionManager, permit2, swapAdapter). One setCfg with every key that differs.
 *   2. the pool allowlist - CONFIG.POOLS. One setPools with every pool whose flag differs.
 *
 * The loop iterates the objects, so a new CHAIN_CFG knob needs no edit here. It only ever
 * WRITES keys that are present; it never zeroes one that disappeared from config.
 */
import type { Hex } from "viem";
import { CHAIN_CFG, CONFIG } from "../server/config";
import { assertChain, explorer, getAccount, getWalletClient, k32, poolKey, publicClient, ZERO } from "./chain";
import { NUTSHELL_ABI } from "../server/utils/nutshell-artifact";

const DRY = process.argv.includes("--dry");
const asUint = (addr: string) => BigInt(addr || ZERO);

async function main() {
  await assertChain();
  const hub = CONFIG.NUTSHELL_ADDRESS as Hex;
  if (!hub) throw new Error("NUTSHELL_ADDRESS is empty - run `npm run contracts:deploy` first");
  if (!CONFIG.SWAP_ADAPTER_ADDRESS) throw new Error("SWAP_ADAPTER_ADDRESS is empty");
  const read = (functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: hub, abi: NUTSHELL_ABI, functionName, args } as never) as Promise<never>;

  // ---- 1. cfg ----
  const desired: Record<string, bigint> = {
    operator: asUint(CONFIG.OPERATOR_ADDRESS),
    nuts: asUint(CONFIG.NUTS_ADDRESS),
    squeekNft: asUint(CONFIG.SQUEEK_NFT_ADDRESS),
    positionManager: asUint(CONFIG.UNI_V4_POSITION_MANAGER),
    permit2: asUint(CONFIG.PERMIT2),
    swapAdapter: asUint(CONFIG.SWAP_ADAPTER_ADDRESS),
  };
  for (const [k, v] of Object.entries(CHAIN_CFG)) desired[k] = v;

  const keys = Object.keys(desired);
  const live = (await read("getCfg", [keys.map(k32)])) as readonly bigint[];
  const changed = keys.filter((k, i) => live[i] !== desired[k]);
  console.log(`hub ${hub}\n`);
  for (const k of changed) console.log(`  ${k.padEnd(16)} ${live[keys.indexOf(k)]}  ->  ${desired[k]}`);
  if (!changed.length) console.log("  cfg: no change");

  // ---- 2. pools ----
  const poolWrites: { key: ReturnType<typeof poolKey>; allowed: boolean; id: string }[] = [];
  for (const p of CONFIG.POOLS) {
    const key = poolKey(p);
    const id = (await read("poolId", [key])) as Hex;
    const isAllowed = (await read("poolAllowed", [id])) as boolean;
    if (isAllowed !== p.allowed) {
      poolWrites.push({ key, allowed: p.allowed, id: p.id });
      console.log(`  pool ${p.id.padEnd(12)} ${isAllowed}  ->  ${p.allowed}`);
    }
  }
  if (!poolWrites.length) console.log("  pools: no change");

  if (DRY || (!changed.length && !poolWrites.length)) return;

  const account = getAccount();
  const owner = (await read("owner")) as string;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`hub owner is ${owner}, deployer is ${account.address} - push from the owner (the Safe, once it owns the hub)`);
  }
  const wallet = getWalletClient();
  const send = async (functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address: hub, abi: NUTSHELL_ABI, functionName, args } as never);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    console.log(`  ${functionName} ${explorer(`tx/${hash}`)}`);
  };

  // nuts must be set before setPools, which checks every pool contains it - so cfg goes first.
  if (changed.length) await send("setCfg", [changed.map(k32), changed.map((k) => desired[k])]);
  if (poolWrites.length) await send("setPools", [poolWrites.map((w) => w.key), poolWrites.map((w) => w.allowed)]);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
