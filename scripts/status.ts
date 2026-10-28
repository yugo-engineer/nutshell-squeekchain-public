/**
 * Read-only snapshot of the hub: ownership, config drift, buckets, positions and epochs.
 *
 *   npm run status
 *
 * Shows "not deployed" rather than inventing a number when an address is empty.
 */
import { formatEther, formatUnits, type Hex } from "viem";
import { CHAIN_CFG, CONFIG } from "../server/config";
import { assertChain, k32, publicClient, ZERO } from "./chain";
import { NUTSHELL_ABI } from "../server/utils/nutshell-artifact";

async function main() {
  await assertChain();
  console.log(`${CONFIG.EVM_CHAIN_NAME} (${CONFIG.EVM_CHAIN_ID})`);
  const hub = CONFIG.NUTSHELL_ADDRESS as Hex;
  if (!hub) {
    console.log("  hub: not deployed");
    return;
  }
  const read = (functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: hub, abi: NUTSHELL_ABI, functionName, args } as never) as Promise<never>;
  const nuts = (CONFIG.NUTS_ADDRESS || ZERO) as Hex;

  const [owner, pending, positions, epochs, burned, paid, reserved] = await Promise.all([
    read("owner"), read("pendingOwner"), read("positionCount"), read("epochCount"),
    read("nutsBurned"), read("rewardsPaid"), read("epochReserved"),
  ]);
  console.log(`  hub       ${hub}`);
  console.log(`  owner     ${owner}${pending !== ZERO ? `  (pending ${pending})` : ""}`);
  if (CONFIG.SAFE_ADDRESS && String(owner).toLowerCase() !== CONFIG.SAFE_ADDRESS.toLowerCase()) {
    console.log("  !! owner is not SAFE_ADDRESS");
  }

  const keys = Object.keys(CHAIN_CFG) as (keyof typeof CHAIN_CFG)[];
  const live = (await read("getCfg", [keys.map(k32)])) as readonly bigint[];
  keys.forEach((k, i) => {
    if (live[i] !== CHAIN_CFG[k]) console.log(`  !! drift ${k}: chain ${live[i]}, config ${CHAIN_CFG[k]}`);
  });

  for (const [label, token] of [["ETH", ZERO], [CONFIG.NUTS_SYMBOL, nuts]] as const) {
    if (token === ZERO && label !== "ETH") continue;
    const [fees, rewards, buyback, free] = (await Promise.all([
      read("feesCollected", [token]), read("rewardsBal", [token]), read("buybackBal", [token]), read("freeBalance", [token]),
    ])) as bigint[];
    const f = (v: bigint) => formatUnits(v, 18);
    console.log(`  ${label.padEnd(5)} fees ${f(fees)}  rewards ${f(rewards)}  buyback ${f(buyback)}  free ${f(free)}`);
  }
  console.log(`  positions ${positions}   epochs ${epochs}   reserved ${formatEther(reserved)} ETH   paid ${formatEther(paid)} ETH`);
  console.log(`  NUTS burned ${formatUnits(burned, 18)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
