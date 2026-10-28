// web/src/lib/config.ts - the CLIENT-SAFE mirror of server/config.ts.
//
// Public values only. This file ships to every browser, so it must NEVER hold the deployer key
// or a keyed RPC URL. `npm run contracts:deploy` (root) patches the address fields here too;
// everything else is kept in sync by hand on purpose.

export const NETWORK = "sepolia" as "sepolia" | "mainnet";

export const CONFIG = {
  CHAIN_ID: NETWORK === "mainnet" ? 1 : 11155111,
  CHAIN_NAME: NETWORK === "mainnet" ? "Ethereum" : "Sepolia",
  /** Keyless public node - shared quota, fine for a landing page, swap for a keyed public one later. */
  RPC_URL: NETWORK === "mainnet" ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com",
  /** Tried in order when RPC_URL fails or times out - keyless public nodes do go down. */
  RPC_FALLBACKS: NETWORK === "mainnet" ? ["https://eth.drpc.org", "https://1rpc.io/eth"] : ["https://sepolia.drpc.org", "https://1rpc.io/sepolia"],
  EXPLORER_URL: NETWORK === "mainnet" ? "https://etherscan.io" : "https://sepolia.etherscan.io",

  // --- Nutshell (patched by `npm run contracts:deploy`) ---------------------
  NUTSHELL_ADDRESS: "0x00915ef0cc3c0abfd5bfbd4398d53d1ad8b2e574" as string,
  NUTS_ADDRESS: "0xb5354f6728ee9ad05f2f6094bc8a33351e13b5fe" as string,
  /** NutsPresale - the Genesis Presale (patched by contracts:deploy). */
  PRESALE_ADDRESS: "0x71df4eda48783406b54565d80fec4a3a7e1bb2d0" as string,
  DEPLOY_BLOCK: 11978539,

  // --- Squeekchain (Sepolia; no mainnet deployment yet) ---------------------
  SQUEEK_NFT_ADDRESS: "0x0eAF3E0d40A0a8E5a6Ac030b2459E9FB0B7905c6",
  SQUEEK_MINING_ADDRESS: "0x3beE588fC20dE788Bac17d33b41Da7346cb27EC4",
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",

  /**
   * TICKER PUBLICATION FLAG (spec section 7). Whether the page may print the token ticker.
   * Publishing it is a communications decision, so it stays off until announced: with false
   * the page says "the Nutshell token" wherever it would say $NUTS.
   */
  SHOW_TICKER: false,
  NUTS_SYMBOL: "NUTS",

  /** Display only - Nutshell.sol hardcodes these. */
  SPLIT: { treasury: 50, rewards: 30, buyback: 20 },

  /** The live market. Its state (planned / live) is read from chain, never assumed. */
  PRIMARY_POOL: { id: "nuts-eth-30", label: "ETH", feeBps: 30, fee: 3000, tickSpacing: 60 },
  /** Uniswap's network slug in app.uniswap.org/explore/pools/<slug>/<poolId>. Verified for
   *  Sepolia 2026-10-23: the page lists our v4 pool, its trades and liquidity, with Swap and
   *  Add liquidity buttons. The plain /swap?outputCurrency= link does NOT prefill a testnet token. */
  UNISWAP_CHAIN: NETWORK === "mainnet" ? "ethereum" : "ethereum_sepolia",

  /**
   * Markets under research. NOT deployed, NOT liquid, NOT assumed available on this network -
   * every one needs issuer and technical review before it can be allowlisted.
   */
  RESEARCH_MARKETS: [
    { ticker: "NVDA", name: "NVIDIA", group: "MAG7" },
    { ticker: "AAPL", name: "Apple", group: "MAG7" },
    { ticker: "MSFT", name: "Microsoft", group: "MAG7" },
    { ticker: "GOOGL", name: "Alphabet", group: "MAG7" },
    { ticker: "TSLA", name: "Tesla", group: "MAG7" },
    { ticker: "COIN", name: "Coinbase", group: "CRYPTO" },
  ],

  /**
   * /admin only: the DESIRED chain state from server/config.ts (CHAIN_CFG, POOLS, PRESALE and
   * the verified addresses), mirrored by hand so the page can show drift the way
   * `npm run config:push:dry` does. Public values only.
   */
  ADMIN: {
    SWAP_ADAPTER_ADDRESS: "0x61fe1bdb5c1637bdb318292247125cd9dd30b624" as string,
    POSITION_MANAGER: NETWORK === "mainnet" ? "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e" : "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
    STATE_VIEW: NETWORK === "mainnet" ? "0x7ffe42c4a5deea5b0fec41c94c136cf115597227" : "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c",
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    CHAIN_CFG: {
      claimDelay: NETWORK === "mainnet" ? 172_800n : 600n,
      epochTtl: 15_552_000n,
      rewardsBps: 3_500n,
      buybackBps: 1_500n,
      maxSwapBps: 0n,
      paused: 0n,
    } as Record<string, bigint>,
    /** Same shape as server/config.ts POOLS. `base` defaults to NUTS, `hooks` to none. */
    POOLS: [
      { id: "nuts-eth-30", pair: "ETH", fee: 3_000, tickSpacing: 60, allowed: true },
    ] as { id: string; pair: "ETH" | string; base?: string; fee: number; tickSpacing: number; hooks?: string; allowed: boolean }[],
    PRESALE: {
      SUPPLY: 1_000_000_000n * 10n ** 18n,
      FDV_USD: 350_000n,
      MIN_USD: 500n,
      MAX_USD: 3_500n,
      P1_CAP: 100_000_000n * 10n ** 18n,
      P2_CAP: 85_700_000n * 10n ** 18n,
      P1_DURATION: 3_600n,
      P2_DURATION: 3_600n,
    },
  },

  /** Published epoch claim data, written by `npm run epoch` into web/public/epochs/<root>/. */
  EPOCHS_BASE: "/epochs",
  /** Highest Squeek id to scan when finding a wallet's Squeeks (SqueekNFT has no enumeration). */
  SQUEEK_SCAN_BATCH: 400,
} as const;

/** "$NUTS" once the ticker is public, a neutral name before. */
export const TOKEN = CONFIG.SHOW_TICKER ? `$${CONFIG.NUTS_SYMBOL}` : "the Nutshell token";
export const TOKEN_SHORT = CONFIG.SHOW_TICKER ? `$${CONFIG.NUTS_SYMBOL}` : "the token";
