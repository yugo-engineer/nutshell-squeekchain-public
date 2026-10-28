/**
 * Shared viem clients for every script. Imports server/config.ts, so this file - and anything
 * that imports it - is SCRIPT-SIDE ONLY.
 */
import { createPublicClient, createWalletClient, defineChain, fallback, http, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIG } from "../server/config";

export const chain = defineChain({
  id: CONFIG.EVM_CHAIN_ID,
  name: CONFIG.EVM_CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: CONFIG.EVM_NATIVE_SYMBOL, decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.EVM_RPC_URL, ...CONFIG.EVM_RPC_FALLBACK_URLS] } },
  blockExplorers: { default: { name: "Etherscan", url: CONFIG.EVM_EXPLORER_URL } },
  contracts: { multicall3: { address: CONFIG.MULTICALL3 as Hex } },
});

const transport = fallback([CONFIG.EVM_RPC_URL, ...CONFIG.EVM_RPC_FALLBACK_URLS].map((u) => http(u, { timeout: 10_000 })));

export const publicClient = createPublicClient({ chain, transport });

/** Fail loudly and early rather than letting a placeholder reach an RPC. */
export function assertKeyPresent(): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(CONFIG.DEPLOYER_PRIVATE_KEY)) {
    throw new Error("server/config.ts DEPLOYER_PRIVATE_KEY is a placeholder - run `npm run keygen` first.");
  }
}

export function getAccount() {
  assertKeyPresent();
  return privateKeyToAccount(CONFIG.DEPLOYER_PRIVATE_KEY as Hex);
}

export function getWalletClient() {
  return createWalletClient({ chain, account: getAccount(), transport });
}

/** Confirms the RPC really is the chain config claims - the difference between a failed
 *  deploy and a deploy to the wrong network. */
export async function assertChain(): Promise<void> {
  const id = await publicClient.getChainId();
  if (id !== CONFIG.EVM_CHAIN_ID) throw new Error(`RPC reports chainId ${id}, config expects ${CONFIG.EVM_CHAIN_ID}`);
  if (!CONFIG.SQUEEK_NFT_ADDRESS) {
    throw new Error(`DEPLOY = "${CONFIG.DEPLOY}" but SQUEEK_NFT_ADDRESS is empty: Squeekchain has no deployment there yet.`);
  }
}

export const explorer = (path: string) => `${CONFIG.EVM_EXPLORER_URL}/${path}`;

/** bytes32 of the ASCII key, right-padded - the hub's cfg keys are literal ASCII. */
export const k32 = (s: string) => stringToHex(s, { size: 32 });

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** The PoolKey a config.POOLS entry describes. "ETH" is native, address(0), and sorts first. */
export function poolKey(p: (typeof CONFIG.POOLS)[number]) {
  const base = (p.base ?? CONFIG.NUTS_ADDRESS) as Hex;
  if (!base) throw new Error("NUTS_ADDRESS is empty");
  const other = (p.pair === "ETH" ? ZERO : p.pair) as Hex;
  const [currency0, currency1] = BigInt(other) < BigInt(base) ? [other, base] : [base, other];
  return { currency0, currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: (p.hooks ?? ZERO) as Hex };
}
