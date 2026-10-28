// server/config.ts - SINGLE SOURCE OF TRUTH, flat 1-depth keys.
//
// Imported ONLY by scripts/ (deploy, push-config, status). NEVER import this from a frontend -
// it carries the deployer private key and a bundler would ship it to the browser. When the UI
// lands, its client-safe mirror is src/lib/config.ts, kept in sync by hand.
//
// Same model as nftlaunchpad2: no process.env, no .env files. One file to read when you want to
// know what the system will do, and every value carries its reasoning next to it.
//
// ============================ THE SHAPE OF NUTSHELL ============================
//   openPosition   the operator puts treasury capital into an allowlisted NUTS/x Uniswap v4
//                  pool; the hub holds the position NFT
//   collectFees    PERMISSIONLESS. Pulls ONLY fees (a zero-liquidity decrease) and splits every
//                  token the moment it lands:
//                      50% treasury  -> stays as free capital for more LP
//                      30% rewards   -> Squeeks reward bucket
//                      20% buyback   -> NUTS is burned on the spot; any other token waits in
//                                       the buyback bucket for swapBucket
//                  The split is a CONSTANT in Nutshell.sol, not config. Nobody can redirect it.
//   swapBucket     operator converts a bucket through one allowlisted pool (rewards -> ETH,
//                  buyback -> NUTS, which is burned). It can never touch principal.
//   postEpoch      owner reserves rewards ETH under a Merkle root of (epoch, squeekId, amount),
//                  weighted by Squeek POWER at a snapshot block
//   claim          pays ETH to ownerOf(squeekId) at claim time - rewards travel with the NFT,
//                  the same rule Squeekchain uses for SQK. NEVER paused.
//
// Principal never enters a bucket and a bucket can never be spent as principal: every move
// re-checks balance >= rewards + buyback + reserved epochs.

import { DEPLOYER_PRIVATE_KEY as SECRET_KEY } from "./secrets";

export type Network =
  | "sepolia" // Ethereum Sepolia testnet, chain 11155111. FREE: gas is paid in faucet ETH.
  //             Public and persistent - where Squeekchain lives today and where the team tests.
  | "mainnet"; // Ethereum mainnet, chain 1. REAL MONEY. Blocked until Squeekchain deploys there.

/**
 * The network every script targets. A hand-flipped constant rather than an env var: changing it
 * is a decision, and it should show up in a diff.
 *
 * !! As of 2026-10-22 Squeekchain has NO mainnet deployment. "mainnet" is refused by
 *    scripts/chain.ts until SQUEEK_NFT_ADDRESS has a mainnet value.
 */
export const DEPLOY = "sepolia" as Network;

/** This network's value. Every network must be given, so adding one is a compile error until
 *  each value has been decided. */
const byNetwork = <T>(v: Record<Network, T>): T => v[DEPLOY];

// --- Chain endpoints ---------------------------------------------------------
// Keyless public nodes for now. Swap in a keyed provider before anything runs a keeper: these
// rate-limit by IP and are fine for a deploy and a config push, not for an indexer.
const MAINNET_RPC = "https://ethereum-rpc.publicnode.com";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

/**
 * DEPLOYED ADDRESSES, ONE BLOCK PER NETWORK - written by `npm run contracts:deploy` into the
 * block for the network DEPLOY names, so switching networks never mixes addresses.
 */
const DEPLOYMENTS = {
  sepolia: {
    NUTSHELL_ADDRESS: "0x00915ef0cc3c0abfd5bfbd4398d53d1ad8b2e574",
    SWAP_ADAPTER_ADDRESS: "0x61fe1bdb5c1637bdb318292247125cd9dd30b624",
    NUTS_ADDRESS: "0xb5354f6728ee9ad05f2f6094bc8a33351e13b5fe",
    /** TEST ONLY: a second V4SwapAdapter whose caller is the deployer, used by `npm run seed` to
     *  play the market. Never allowlisted anywhere; holds nothing. */
    TRADER_ADAPTER_ADDRESS: "0x7ada74d74052c37a5c8ab734f78de112f81e11b5",
    PRESALE_ADDRESS: "0x71df4eda48783406b54565d80fec4a3a7e1bb2d0",
    DEPLOY_BLOCK: 11978539,
  },
  mainnet: {
    NUTSHELL_ADDRESS: "",
    SWAP_ADAPTER_ADDRESS: "",
    TRADER_ADAPTER_ADDRESS: "",
    PRESALE_ADDRESS: "",
    /** The REAL launch token, set by hand - deploy never invents one on mainnet. */
    NUTS_ADDRESS: "",
    DEPLOY_BLOCK: 0,
  },
} satisfies Record<Network, { NUTSHELL_ADDRESS: string; SWAP_ADAPTER_ADDRESS: string; TRADER_ADAPTER_ADDRESS: string; PRESALE_ADDRESS: string; NUTS_ADDRESS: string; DEPLOY_BLOCK: number }>;

/**
 * THE ON-CHAIN CONFIG MAP.
 *
 * Every one of these is a uint256 in Nutshell.cfg, keyed by its bytes32 ASCII name. This object
 * IS the desired chain state: `npm run config:push` reads each key off chain, diffs it against
 * the value here, and writes only what differs. A config value that cannot change chain state
 * is a lie.
 *
 * Addresses go in the same map as uint256(uint160(addr)), written by push-config from the
 * address fields below - not by hand here.
 */
export const CHAIN_CFG = {
  // --- Rewards ----------------------------------------------------------
  /**
   * Seconds between postEpoch and the first claim. THIS is the review window: during it the
   * owner can cancelEpoch() a bad root and the ETH returns to the rewards bucket untouched.
   * After it, the root is final. 2 days on mainnet; 10 minutes on Sepolia so a test epoch does
   * not cost an afternoon. The contract caps it at 30 days.
   */
  claimDelay: byNetwork({ sepolia: 600n, mainnet: 172_800n }),
  /**
   * Seconds an epoch stays claimable after claimDelay. When it lapses ANYONE may closeEpoch(),
   * and the unclaimed ETH rolls back into the rewards bucket for the next epoch - never to the
   * treasury. 180 days: epochs are monthly, so this keeps ~6 of them open at once. The contract
   * refuses anything under 1 day.
   */
  epochTtl: 15_552_000n,

  // --- Revenue split (bps of every collected fee) -------------------------
  /**
   * The tokenomics doc: treasury at least 50%, Squeeks up to 35%, buyback & burn 15%. The hub
   * refuses rewardsBps > 3500 or rewardsBps + buybackBps > 5000, so the treasury (the remainder)
   * can never fall below half. The operator may change these; a change applies to fees collected
   * after it. 0 / 0 sends everything to the treasury.
   */
  rewardsBps: 3_500n,
  buybackBps: 1_500n,
  /** Max share of a source balance one swap may spend (bucket or treasury), bps. 0 = no cap. */
  maxSwapBps: 0n,

  /** 1 pauses openPosition, increasePosition, swapBucket and postEpoch. It NEVER pauses claim,
   *  collectFees, decreasePosition, closePosition or closeEpoch - exits always work. */
  paused: 0n,
} as const;

export type ChainCfgKey = keyof typeof CHAIN_CFG;

/**
 * THE GENESIS PRESALE TERMS, from the tokenomics doc. `npm run presale -- configure` pushes
 * them; they freeze the moment phase 1 starts.
 *
 *   phase 1  Squeeks holders (snapshot), 10% of supply, 1 hour or until sold out
 *   phase 2  anyone, 8.57% + phase 1's unsold, 1 hour or until sold out, starting the moment
 *            phase 1 ends
 *   price    FDV / supply = $350,000 / 1B = $0.00035 per NUTS; $500-$3,500 per wallet across
 *            both phases; paid in ETH at ETH_USD (set when each phase opens)
 *   result   no soft cap - whatever sells, sells, and Nutshell launches. ETH goes straight to
 *            the hub as treasury capital. Buyers claim 100% at TGE.
 */
export const PRESALE = {
  SUPPLY: 1_000_000_000n * 10n ** 18n,
  FDV_USD: 350_000n,
  MIN_USD: 500n,
  MAX_USD: 3_500n,
  P1_CAP: 100_000_000n * 10n ** 18n, //  10%    of 1B
  P2_CAP: 85_700_000n * 10n ** 18n, //   8.57% of 1B
  P1_DURATION: 3_600n,
  P2_DURATION: 3_600n,
  /** USD per ETH, 8 decimals. Measured 2026-10-22: $2,380. Update before each phase opens. */
  ETH_USD_E8: 2_380n * 10n ** 8n,
  /**
   * TESTNET ONLY: extra wallets added to the phase-1 whitelist on top of the Squeeks snapshot, so
   * the team can test phase 1 without holding a Squeek. `whitelist` refuses to add them on mainnet.
   */
  TEST_WHITELIST: ["0xfb0da3525D4E1DA2142F4cB464f5244079CfB491"] as string[],
} as const;

export const CONFIG = {
  DEPLOY,

  // --- Chain ------------------------------------------------------------
  // Ethereum L1. 24,576-byte contract size limit applies here - unlike nftlaunchpad2's Orbit
  // chain - so the compile script does NOT suppress solc warning 5574.
  // MEASURED 2026-10-22: mainnet base fee 0.05-0.12 gwei (median of the last 1024 blocks 0.21,
  // max 0.75), ETH $2,380. Deploy gas, eth_estimateGas against mainnet with the compiled
  // artifacts: Nutshell 4,095,636 + V4SwapAdapter 887,970 = ~5.0M gas -> ~$2.40 at 0.2 gwei,
  // ~$12 at 1 gwei.
  // !! SEPOLIA PRICES CODE DIFFERENTLY: the same deploy estimates at 38.7M gas there (Nutshell
  //    alone 29.0M) with a 200M block gas limit - it is running a newer fork than mainnet. Free
  //    either way, but if Sepolia also enforces a per-transaction gas cap the hub deploy can be
  //    refused there while still fitting comfortably on mainnet.
  EVM_CHAIN_ID: byNetwork({ sepolia: 11155111, mainnet: 1 }),
  EVM_CHAIN_NAME: byNetwork({ sepolia: "Sepolia", mainnet: "Ethereum" }),
  EVM_NATIVE_SYMBOL: "ETH",
  EVM_RPC_URL: byNetwork({ sepolia: SEPOLIA_RPC, mainnet: MAINNET_RPC }),
  /**
   * Tried in order when the primary fails or times out. MEASURED 2026-10-23: publicnode Sepolia
   * timed out on every call for minutes while these answered in ~0.5 s - keyless public nodes
   * go down, so never run on one alone.
   */
  EVM_RPC_FALLBACK_URLS: byNetwork({
    sepolia: ["https://sepolia.drpc.org", "https://1rpc.io/sepolia"],
    mainnet: ["https://eth.drpc.org", "https://1rpc.io/eth"],
  }) as string[],
  EVM_EXPLORER_URL: byNetwork({ sepolia: "https://sepolia.etherscan.io", mainnet: "https://etherscan.io" }),

  // --- Owner / deployer -------------------------------------------------
  /**
   * Owns the hub, and through it every knob and the right to post reward epochs.
   * Starts as the deployer. Nutshell has 2-step transferOwnership, so the plan is: deploy from
   * this key, push config, then transferOwnership to the Safe below and accept from the Safe.
   */
  OWNER_ADDRESS: "0xfb0da3525D4E1DA2142F4cB464f5244079CfB491" as string,
  /**
   * The Safe that should own the hub before it holds real value. Empty until created.
   * Use at least 2-of-3 - SHROOM's 1-of-3 treasury is the example NOT to follow.
   */
  SAFE_ADDRESS: "" as string,
  /**
   * May open/increase/decrease/close positions and run swapBucket. Cannot withdraw, cannot post
   * epochs, cannot touch config. Zero = owner only. Usually a hot keeper key with little ETH.
   */
  OPERATOR_ADDRESS: "" as string,
  // !! PRIVATE KEY - lives in server/secrets.ts, which is GITIGNORED, so the key never reaches the
  //    repo. `npm run keygen` creates that file. Script side only; never log it.
  DEPLOYER_PRIVATE_KEY: SECRET_KEY as string,

  // --- Deployed contracts: this network's block of DEPLOYMENTS above ------
  // Nutshell is the hub (config + positions + split + buyback + rewards); V4SwapAdapter is the
  // only thing that ever runs inside PoolManager.unlock; NUTS_ADDRESS on sepolia is the
  // TEST token contracts/NutsToken.sol (fixed supply, burn() reduces totalSupply). On mainnet it
  // must be the REAL launch token with a burn(uint256) that lowers totalSupply - a transfer to
  // 0xdead is NOT a burn (that is exactly what SHROOM does).
  NUTSHELL_ADDRESS: DEPLOYMENTS[DEPLOY].NUTSHELL_ADDRESS as string,
  SWAP_ADAPTER_ADDRESS: DEPLOYMENTS[DEPLOY].SWAP_ADAPTER_ADDRESS as string,
  NUTS_ADDRESS: DEPLOYMENTS[DEPLOY].NUTS_ADDRESS as string,
  TRADER_ADAPTER_ADDRESS: DEPLOYMENTS[DEPLOY].TRADER_ADAPTER_ADDRESS as string,
  PRESALE_ADDRESS: DEPLOYMENTS[DEPLOY].PRESALE_ADDRESS as string,
  /** Block of the first deploy. fromBlock floor for any log scan. */
  DEPLOY_BLOCK: DEPLOYMENTS[DEPLOY].DEPLOY_BLOCK as number,
  NUTS_SYMBOL: "NUTS",
  /** Test token supply, whole tokens. Only used when deploying NutsToken off mainnet. */
  TEST_NUTS_SUPPLY: 1_000_000_000n,

  // --- Uniswap v4 -------------------------------------------------------
  // !! EVERY address below was verified on chain 2026-10-22: code present, and
  //    PositionManager.poolManager() / StateView.poolManager() return the PoolManager listed,
  //    PositionManager.permit2() returns Permit2. Re-check before adding a network.
  UNI_V4_POOL_MANAGER: { sepolia: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543", mainnet: "0x000000000004444c5dc75cB358380D2e3dE08A90" }[DEPLOY],
  UNI_V4_POSITION_MANAGER: { sepolia: "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4", mainnet: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e" }[DEPLOY],
  /** Read-only pool state (slot0, liquidity). Used by scripts to size positions. */
  UNI_V4_STATE_VIEW: { sepolia: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c", mainnet: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227" }[DEPLOY],
  UNI_V4_QUOTER: { sepolia: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227", mainnet: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203" }[DEPLOY],
  /** Same address on every chain. PositionManager pulls ERC-20s through it. */
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  /** Batched reads for the epoch snapshot (~9,000 Squeeks in ~23 calls). Same address on every
   *  chain; used by scripts only. */
  MULTICALL3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  /** Recorded only. Pools pair NUTS against NATIVE ETH (currency0 = address(0)), so rewards
   *  are paid in ETH with no unwrap step. Nothing in the protocol calls WETH. */
  WETH: { sepolia: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", mainnet: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }[DEPLOY],

  /**
   * THE POOL ALLOWLIST, as desired state. `npm run config:push` writes setPools for anything
   * that differs. ANY pool is allowed - NUTS/stock and NUTS/ETH first, but also stock/stable,
   * SQK/ETH or anything else worth earning fees in. `base` defaults to NUTS; set it to another
   * token address for a pool without NUTS. `hooks` defaults to none.
   * !! A hook can take part of every fee (SHROOM's genesis pool: Pons takes a cut). The hub no
   *    longer refuses hooked pools - vet a hook before listing its pool.
   *
   * currency0 must sort below currency1; "ETH" means native (address(0)) and always sorts first.
   * `allowed: false` revokes. A pool deleted from this list is left as it is on chain.
   */
  POOLS: [
    // NUTS/ETH 0.30% - the principal market. Fee tier is still an open decision (0.3% vs 1%).
    { id: "nuts-eth-30", pair: "ETH", fee: 3_000, tickSpacing: 60, allowed: true },
  ] as { id: string; pair: "ETH" | string; base?: string; fee: number; tickSpacing: number; hooks?: string; allowed: boolean }[],

  // --- Squeekchain ------------------------------------------------------
  // From docs.squeekchain.com/developers, read 2026-10-22. Code length checked on Sepolia.
  // Contract source is NOT verified on Etherscan; decode with Squeekchain's published ABIs.
  /**
   * SqueekNFT (Squeeks). IMMUTABLE ERC-721 - no proxy, no owner. claim() pays
   * ownerOf(squeekId), so this is the one Squeekchain address the hub depends on.
   * Merges BURN the donor: a burned ID's ownerOf reverts, its share stays unclaimed and rolls
   * forward when the epoch closes.
   */
  SQUEEK_NFT_ADDRESS: { sepolia: "0x0eAF3E0d40A0a8E5a6Ac030b2459E9FB0B7905c6", mainnet: "" }[DEPLOY],
  /**
   * SqueekMining - an UPGRADEABLE transparent proxy (timelock with 60 s delay on Sepolia). The
   * hub NEVER calls it. Only the off-chain epoch snapshot reads activeWeight from it, at a fixed
   * block, so an upgrade can change future snapshots but never a posted root.
   */
  SQUEEK_MINING_ADDRESS: { sepolia: "0x3beE588fC20dE788Bac17d33b41Da7346cb27EC4", mainnet: "" }[DEPLOY],
  /** Squeeks use collection selector 0 in SqueekMining. */
  SQUEEK_COLLECTION: 0,
  SQK_ADDRESS: { sepolia: "0x6872bfa5ccc3e9e440c6c16e5ffdabb8dba4cc76", mainnet: "" }[DEPLOY],
  /** First block with Squeekchain state. Snapshot scans start here. */
  SQUEEK_INDEX_FROM_BLOCK: { sepolia: 11_902_282, mainnet: 0 }[DEPLOY],

  // --- The on-chain config map ------------------------------------------
  CHAIN_CFG,

  // --- Genesis presale (contracts/NutsPresale.sol) ------------------------
  PRESALE,

  // --- Compiler / verification ------------------------------------------
  /**
   * Pinned EXACT (not ^) in package.json. foundry.toml MUST keep mirroring these values, or the
   * tests stop exercising the configuration that actually deploys.
   */
  SOLC_VERSION: "0.8.35",
  EVM_VERSION: "cancun",
  OPTIMIZER_RUNS: 200,
  VIA_IR: false,
} as const;

export type Config = typeof CONFIG;
