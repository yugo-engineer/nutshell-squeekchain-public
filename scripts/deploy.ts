/**
 * Deploys the protocol and writes every address back into server/config.ts.
 *
 *   npm run contracts:deploy:dry     # estimate gas and cost, spend nothing
 *   npm run contracts:deploy
 *
 * Deploys, in order:
 *   NutsToken      ONLY on "sepolia" (test token). On mainnet NUTS_ADDRESS is
 *                  the real launch token, set by hand, and this step refuses to invent one.
 *   Nutshell       the hub. Deployer becomes owner.
 *   V4SwapAdapter  bound to the PoolManager and to the hub as its only caller.
 *
 * There is no wiring step: the hub IS the config, so `npm run config:push` afterwards sets every
 * knob and the pool allowlist in two owner transactions.
 *
 * RESUMABLE. An address already in config is adopted only if its deployed code is the size the
 * compiled artifact says, and each new address is written to disk the moment its receipt lands -
 * a revert on step three must not cost steps one and two.
 */
import { encodeDeployData, formatEther, type Abi, type Hex } from "viem";
import { CONFIG } from "../server/config";
import { patchConfigs } from "./config-files";
import { assertChain, explorer, getAccount, getWalletClient, publicClient } from "./chain";
import { NUTS_TOKEN_ABI, NUTS_TOKEN_BYTECODE, NUTS_TOKEN_RUNTIME_SIZE } from "../server/utils/nutstoken-artifact";
import { NUTSHELL_ABI, NUTSHELL_BYTECODE, NUTSHELL_RUNTIME_SIZE } from "../server/utils/nutshell-artifact";
import { NUTS_PRESALE_ABI, NUTS_PRESALE_BYTECODE, NUTS_PRESALE_RUNTIME_SIZE } from "../server/utils/nutspresale-artifact";
import {
  V4_SWAP_ADAPTER_ABI,
  V4_SWAP_ADAPTER_BYTECODE,
  V4_SWAP_ADAPTER_RUNTIME_SIZE,
} from "../server/utils/v4swapadapter-artifact";

const DRY = process.argv.includes("--dry-run");
/** Dry runs work without a key: estimates come from this address instead. */
const DRY_FROM = "0x000000000000000000000000000000000000dEaD" as Hex;

type AddrKey = "NUTS_ADDRESS" | "NUTSHELL_ADDRESS" | "SWAP_ADAPTER_ADDRESS" | "PRESALE_ADDRESS";

let totalWei = 0n;

async function deployOne(
  label: string,
  key: AddrKey,
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[],
  runtimeSize: number,
  boundTo?: { fn: string; expect: Hex }
): Promise<Hex> {
  const existing = CONFIG[key] as Hex | "";
  if (existing) {
    const code = await publicClient.getCode({ address: existing });
    const size = code ? (code.length - 2) / 2 : 0;
    // An adapter or presale is bound to ONE hub by an immutable. Same bytecode size is not
    // enough to adopt it after the hub was redeployed - it must point at the hub we have now.
    const bound = !boundTo || (size === runtimeSize && ((await publicClient.readContract({ address: existing, abi, functionName: boundTo.fn } as never)) as string).toLowerCase() === boundTo.expect.toLowerCase());
    if (size === runtimeSize && bound) {
      console.log(`  ${label.padEnd(14)} adopted ${existing}`);
      return existing;
    }
    console.log(`  ${label.padEnd(14)} ${existing} has ${size} B of code, artifact has ${runtimeSize} B - redeploying`);
  }

  const from = DRY && !/^0x[0-9a-fA-F]{64}$/.test(CONFIG.DEPLOYER_PRIVATE_KEY) ? DRY_FROM : getAccount().address;
  const data = encodeDeployData({ abi, bytecode, args });
  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: from, data }),
    publicClient.getGasPrice(),
  ]);
  const cost = gas * gasPrice;
  totalWei += cost;
  console.log(`  ${label.padEnd(14)} ~${gas.toLocaleString()} gas  ~${formatEther(cost)} ETH`);
  if (DRY) return from; // stand-in so later constructors still estimate

  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({ data, gas: (gas * 12n) / 10n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${label} deploy failed: ${hash}`);
  const addr = receipt.contractAddress;
  console.log(`  ${"".padEnd(14)} ${addr}  ${explorer(`tx/${hash}`)}`);

  const patch: Record<string, string> = { [key]: addr };
  if (key === "NUTSHELL_ADDRESS") patch.DEPLOY_BLOCK = receipt.blockNumber.toString();
  patchConfigs(patch);
  return addr;
}

async function main() {
  await assertChain();
  console.log(`${CONFIG.EVM_CHAIN_NAME} (${CONFIG.EVM_CHAIN_ID})${DRY ? "  DRY RUN" : ""}\n`);

  if (CONFIG.DEPLOY === "mainnet") {
    if (!CONFIG.NUTS_ADDRESS) throw new Error('DEPLOY = "mainnet": set NUTS_ADDRESS to the real launch token by hand.');
  } else {
    const supply = CONFIG.TEST_NUTS_SUPPLY * 10n ** 18n;
    await deployOne("NutsToken", "NUTS_ADDRESS", NUTS_TOKEN_ABI as Abi, NUTS_TOKEN_BYTECODE,
      ["Nutshell Test", CONFIG.NUTS_SYMBOL, supply], NUTS_TOKEN_RUNTIME_SIZE);
  }

  const hub = await deployOne("Nutshell", "NUTSHELL_ADDRESS", NUTSHELL_ABI as Abi, NUTSHELL_BYTECODE, [],
    NUTSHELL_RUNTIME_SIZE);
  await deployOne("V4SwapAdapter", "SWAP_ADAPTER_ADDRESS", V4_SWAP_ADAPTER_ABI as Abi, V4_SWAP_ADAPTER_BYTECODE,
    [CONFIG.UNI_V4_POOL_MANAGER, hub], V4_SWAP_ADAPTER_RUNTIME_SIZE, { fn: "caller", expect: hub });
  // The presale sends every wei to the hub as treasury capital.
  await deployOne("NutsPresale", "PRESALE_ADDRESS", NUTS_PRESALE_ABI as Abi, NUTS_PRESALE_BYTECODE,
    [hub], NUTS_PRESALE_RUNTIME_SIZE, { fn: "treasury", expect: hub });

  console.log(`\n  total ~${formatEther(totalWei)} ETH at the current gas price`);
  if (!DRY) console.log("\nnext: npm run config:push");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
