/**
 * TESTNET ONLY: puts real activity through the deployed hub so every number on the site is live.
 *
 *   npm run seed                 # first run: pool + position + trades + collect + buyback
 *   npm run seed -- --trades 10  # later runs: more trades, collect, buyback, rewards -> ETH
 *
 * Steps, each skipped when already done:
 *   1. initialise the NUTS/ETH v4 pool at 1 ETH = 1,000,000 NUTS (CONFIG.POOLS[0])
 *   2. fund the hub with principal and open ONE full-range position (only if it has none)
 *   3. deploy a "trader" V4SwapAdapter whose caller is the deployer, and round-trip trades
 *      through the pool (buy NUTS with ETH, sell exactly that back), paying the 0.3% LP fee
 *   4. collectFees -> the 50/30/20 split lands on chain
 *   5. swapBucket: buyback ETH -> NUTS (burned), rewards NUTS -> ETH
 *
 * Slippage: the trader and bucket swaps pass minOut = 1. That is deliberate and ONLY acceptable
 * here - nobody else trades this test pool. Real operator scripts must quote first.
 */
import { encodeAbiParameters, formatEther, keccak256, parseAbi, parseEther, type Abi, type Hex } from "viem";
import { CONFIG } from "../server/config";
import { assertChain, explorer, getAccount, getWalletClient, poolKey, publicClient } from "./chain";
import { patchConfigs } from "./config-files";
import { NUTSHELL_ABI } from "../server/utils/nutshell-artifact";
import { NUTS_TOKEN_ABI } from "../server/utils/nutstoken-artifact";
import { V4_SWAP_ADAPTER_ABI, V4_SWAP_ADAPTER_BYTECODE, V4_SWAP_ADAPTER_RUNTIME_SIZE } from "../server/utils/v4swapadapter-artifact";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const TRADES = Number(arg("trades") ?? 6);
const TRADE_ETH = parseEther(arg("size") ?? "0.004");

// Principal for the first position: 0.04 ETH + 40,000 NUTS at 1 ETH = 1,000,000 NUTS.
const SEED_ETH = parseEther("0.04");
const SEED_NUTS = parseEther("40000");
const SQRT_PRICE = 79228162514264337593543950336000n; // sqrt(1e6) * 2^96
const LO = -887220; // full range, tickSpacing 60
const HI = 887220;
const LIQUIDITY = 40_000_000_000_000_000_000n; // sqrt(0.04e18 * 40000e18) = 4e19

const PM_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function initialize(PoolKey key, uint160 sqrtPriceX96) returns (int24)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

const hub = CONFIG.NUTSHELL_ADDRESS as Hex;
const nuts = CONFIG.NUTS_ADDRESS as Hex;
const account = getAccount();
const wallet = getWalletClient();

async function send(label: string, req: Record<string, unknown>) {
  const hash = await wallet.writeContract(req as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label.padEnd(30)} ${explorer(`tx/${hash}`)}`);
  return r;
}
const readHub = (functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: hub, abi: NUTSHELL_ABI, functionName, args } as never) as Promise<never>;

async function traderAdapter(): Promise<Hex> {
  const existing = CONFIG.TRADER_ADAPTER_ADDRESS as Hex | "";
  if (existing) {
    const code = await publicClient.getCode({ address: existing });
    if (code && (code.length - 2) / 2 === V4_SWAP_ADAPTER_RUNTIME_SIZE) return existing;
  }
  const hash = await wallet.deployContract({
    abi: V4_SWAP_ADAPTER_ABI as Abi,
    bytecode: V4_SWAP_ADAPTER_BYTECODE,
    args: [CONFIG.UNI_V4_POOL_MANAGER, account.address],
  } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error("trader adapter deploy failed");
  patchConfigs({ TRADER_ADAPTER_ADDRESS: r.contractAddress });
  console.log(`  ${"trader adapter".padEnd(30)} ${r.contractAddress}`);
  return r.contractAddress;
}

async function main() {
  if (CONFIG.DEPLOY === "mainnet") throw new Error("seed is testnet-only");
  await assertChain();
  if (!hub || !nuts) throw new Error("deploy first: NUTSHELL_ADDRESS / NUTS_ADDRESS are empty");
  const key = poolKey(CONFIG.POOLS[0]);
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
  console.log(`hub ${hub}\npool ${id}\n`);

  // 1. pool
  const [sqrt] = (await publicClient.readContract({
    address: CONFIG.UNI_V4_STATE_VIEW as Hex, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [id],
  })) as readonly [bigint, number, number, number];
  if (sqrt === 0n) await send("initialize pool", { address: CONFIG.UNI_V4_POOL_MANAGER, abi: PM_ABI, functionName: "initialize", args: [key, SQRT_PRICE] });
  else console.log("  pool already initialised");

  // 2. principal + position
  const positions = (await readHub("positionCount")) as bigint;
  let posId: bigint;
  if (positions === 0n) {
    const hashEth = await wallet.sendTransaction({ to: hub, value: (SEED_ETH * 105n) / 100n });
    await publicClient.waitForTransactionReceipt({ hash: hashEth });
    console.log(`  ${"fund hub with ETH".padEnd(30)} ${explorer(`tx/${hashEth}`)}`);
    await send("fund hub with NUTS", { address: nuts, abi: NUTS_TOKEN_ABI, functionName: "transfer", args: [hub, (SEED_NUTS * 105n) / 100n] });
    posId = (await publicClient.readContract({
      address: CONFIG.UNI_V4_POSITION_MANAGER as Hex, abi: parseAbi(["function nextTokenId() view returns (uint256)"]), functionName: "nextTokenId",
    })) as bigint;
    await send("openPosition", {
      address: hub, abi: NUTSHELL_ABI, functionName: "openPosition",
      args: [key, LO, HI, LIQUIDITY, (SEED_ETH * 105n) / 100n, (SEED_NUTS * 105n) / 100n],
    });
  } else {
    posId = (await readHub("positionIds", [0n])) as bigint;
    console.log(`  position #${posId} already open`);
  }

  // 3. trades
  const trader = await traderAdapter();
  const ethIsZero = key.currency0 === "0x0000000000000000000000000000000000000000";
  for (let i = 0; i < TRADES; i++) {
    const before = (await publicClient.readContract({ address: nuts, abi: NUTS_TOKEN_ABI, functionName: "balanceOf", args: [account.address] } as never)) as bigint;
    await send(`trade ${i + 1}/${TRADES}: buy`, {
      address: trader, abi: V4_SWAP_ADAPTER_ABI, functionName: "swap", args: [key, ethIsZero, TRADE_ETH, 1n], value: TRADE_ETH,
    });
    const got = ((await publicClient.readContract({ address: nuts, abi: NUTS_TOKEN_ABI, functionName: "balanceOf", args: [account.address] } as never)) as bigint) - before;
    await send(`trade ${i + 1}/${TRADES}: sell back`, { address: nuts, abi: NUTS_TOKEN_ABI, functionName: "transfer", args: [trader, got] });
    await send(`trade ${i + 1}/${TRADES}: swap`, { address: trader, abi: V4_SWAP_ADAPTER_ABI, functionName: "swap", args: [key, !ethIsZero, got, 1n] });
  }

  // 4. collect -> split
  await send("collectFees", { address: hub, abi: NUTSHELL_ABI, functionName: "collectFees", args: [[posId]] });

  // 5. buckets
  const ZERO = "0x0000000000000000000000000000000000000000";
  const buyEth = (await readHub("buybackBal", [ZERO])) as bigint;
  if (buyEth > 0n) await send("buyback ETH -> NUTS -> burn", { address: hub, abi: NUTSHELL_ABI, functionName: "swapBucket", args: [1, key, ethIsZero, buyEth, 1n] });
  const rewardNuts = (await readHub("rewardsBal", [nuts])) as bigint;
  if (rewardNuts > 0n) await send("rewards NUTS -> ETH", { address: hub, abi: NUTSHELL_ABI, functionName: "swapBucket", args: [0, key, !ethIsZero, rewardNuts, 1n] });

  const [fees, rewards, burned] = (await Promise.all([readHub("feesCollected", [ZERO]), readHub("rewardsBal", [ZERO]), readHub("nutsBurned")])) as bigint[];
  console.log(`\n  fees collected ${formatEther(fees)} ETH   rewards bucket ${formatEther(rewards)} ETH   burned ${formatEther(burned)} NUTS`);
  console.log(`  deployer balance ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
