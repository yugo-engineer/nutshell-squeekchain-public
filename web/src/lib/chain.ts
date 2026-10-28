"use client";
/**
 * Browser-side chain access. Reads go through a public client on CONFIG.RPC_URL; writes go
 * through the visitor's own wallet (EIP-1193 `window.ethereum`). There is no backend.
 */
import {
  createPublicClient,
  encodeAbiParameters,
  keccak256,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { CONFIG } from "./config";

export const chain = defineChain({
  id: CONFIG.CHAIN_ID,
  name: CONFIG.CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.RPC_URL, ...CONFIG.RPC_FALLBACKS] } },
  blockExplorers: { default: { name: "Etherscan", url: CONFIG.EXPLORER_URL } },
  contracts: { multicall3: { address: CONFIG.MULTICALL3 as Hex } },
});

export const publicClient = createPublicClient({
  chain,
  transport: fallback([CONFIG.RPC_URL, ...CONFIG.RPC_FALLBACKS].map((u) => http(u, { batch: true, timeout: 8_000 }))),
});

export const ETH = "0x0000000000000000000000000000000000000000" as const;
export const HUB = (CONFIG.NUTSHELL_ADDRESS || null) as Hex | null;
export const NUTS = (CONFIG.NUTS_ADDRESS || null) as Hex | null;

export const ERC20_ABI = parseAbi(["function totalSupply() view returns (uint256)"]);
export const SQUEEK_NFT_ABI = parseAbi([
  "function ownerOf(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function nextPublicTokenId() view returns (uint256)",
  "function nextReserveTokenId() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
export const SQUEEK_MINING_ABI = parseAbi([
  "struct MiningPosition { uint64 activeWeight; uint64 pendingWeight; uint40 pendingRound; uint48 nextMergeBlock; uint8 level; uint256 lastIndex; uint256 accruedScaled; }",
  "function position(uint8 collection, uint256 tokenId) view returns (MiningPosition)",
]);

/** The v4 PoolId of the primary NUTS/ETH pool: keccak256(abi.encode(PoolKey)). ETH sorts first. */
export const PRIMARY_POOL_ID: Hex | null = NUTS
  ? keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [ETH, NUTS, CONFIG.PRIMARY_POOL.fee, CONFIG.PRIMARY_POOL.tickSpacing, ETH]
      )
    )
  : null;
export const uniswapPool = (id: Hex) => `https://app.uniswap.org/explore/pools/${CONFIG.UNISWAP_CHAIN}/${id}`;

export const explorer = (kind: "tx" | "address", v: string) => `${CONFIG.EXPLORER_URL}/${kind}/${v}`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

/** Connects the injected wallet and makes sure it is on the right chain. */
export async function connectWallet(): Promise<{ address: Hex; wallet: ReturnType<typeof createWalletClient> }> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask, Rabby or similar.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Hex[];
  const current = Number(await eth.request({ method: "eth_chainId" }));
  if (current !== CONFIG.CHAIN_ID) {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CONFIG.CHAIN_ID.toString(16)}` }] });
  }
  const wallet = createWalletClient({ account: address, chain, transport: custom(eth) });
  return { address, wallet };
}
