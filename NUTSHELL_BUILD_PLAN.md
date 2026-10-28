# Nutshell — Build Plan

Draft 2026-10-22. Based on the Core Protocol Spec (2026-10-21) and the SHROOM onchain review
([SHROOM_onchain_reference.md](SHROOM_onchain_reference.md)).

Principle: build everything **chain-agnostic and mock-backed first** (local Anvil + testnet), so M0
decisions can land in parallel without blocking M1 contract work. Nothing touches mainnet capital
before M4.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Contracts | Solidity 0.8.26, **Foundry**, OpenZeppelin v5 | Fuzz/invariant tests, fork testing, scripted deploys |
| DEX (first adapter) | **Uniswap v4** (PositionManager + PoolManager) | Live on Robinhood Chain, Ethereum, Sepolia; SHROOM proves the pattern |
| Admin | **Safe 2-of-3 (or 3-of-5) → OZ TimelockController (48h)** | Fixes SHROOM's 1-of-3 Safe with no timelock |
| Indexer | **Ponder** (TypeScript, event-sourced, Postgres) | Typed handlers per event, built-in GraphQL/SQL API |
| Frontend | Next.js + wagmi/viem + Tailwind | Standard wallet stack; pixel-art brand theme |
| Rewards tooling | TS script: snapshot → Merkle tree → IPFS/Arweave | Works even if Squeeks NFT lives on another chain |

Repo layout (monorepo):
```
nutshell/
  contracts/   src/ test/ script/        (Foundry)
  indexer/     ponder.config.ts src/     (Ponder)
  web/         app/ components/          (Next.js)
  ops/         merkle/ keeper/ runbooks/ (scripts + docs)
```

---

## 2. Contract architecture

```
           Safe (2/3) ──► Timelock (48h) ──► AccessController (roles)
                                                   │
   ┌────────────────────┬──────────────────────────┼─────────────────────┬────────────────────┐
   ▼                    ▼                          ▼                     ▼                    ▼
TreasuryVault ◄──► LiquidityManager ──► IDexAdapter (UniV4Adapter)   PriceOracle       Pause flags
   │  holds tokens + LP NFTs        collect fees ──► RevenueController
   │                                                   │ finalize period, split 50/30/20
   ◄──────────── 50% ──────────────────────────────────┤
                         30% ──► SqueeksRewardDistributor (Merkle, ETH claims)
                         20% ──► BuybackBurnExecutor ──► swap WETH→NUTS ──► NUTS.burn()
```

### Roles (AccessController)
| Role | Holder | Can |
|---|---|---|
| `GOVERNOR` | Timelock (owned by Safe) | Allowlists, caps, adapters, oracle sources, role grants, upgrades |
| `OPERATOR` | Safe directly (later: keeper bot with caps) | Open/increase/decrease/close positions, collect fees, execute buybacks |
| `ACCOUNTANT` | Safe or designated signer | Propose accounting periods, post reward Merkle roots |
| `GUARDIAN` | Fast multisig / any 1 signer | **Pause only** (separately: LP mgmt, distributions, buybacks). Unpause = GOVERNOR |

No role can send funds to a non-allowlisted address. The 50/30/20 split is **`immutable` constants** (recommended: changing it means a new RevenueController deployed through the timelock, publicly visible).

### A. TreasuryVault
- Holds ERC-20s and LP position NFTs (`IERC721Receiver`).
- Bucketed ledger per token: `principal[positionId]`, `unallocatedRevenue`, `operatingReserve`, `treasuryGrowth` (the 50%).
- Outflows only to allowlisted contracts (LiquidityManager, distributor, executor); **daily outgoing notional cap**.
- Emergency: `pause()`; `emergencyWithdraw` only to the Safe, timelocked.

### B. LiquidityManager + IDexAdapter
```solidity
interface IDexAdapter {
  function open(PoolKey, int24 lo, int24 hi, uint256 a0Max, uint256 a1Max) returns (uint256 posId, uint256 used0, uint256 used1);
  function increase(uint256 posId, uint256 a0Max, uint256 a1Max) returns (uint256 used0, uint256 used1);
  function decrease(uint256 posId, uint128 liquidity, uint256 min0, uint256 min1) returns (uint256 out0, uint256 out1);
  function collect(uint256 posId) returns (uint256 fee0, uint256 fee1);
  function close(uint256 posId, uint256 min0, uint256 min1) returns (uint256 out0, uint256 out1);
}
```
- **Clean fee/principal separation:** every `decrease`/`close` first calls `collect` (v4 `DECREASE_LIQUIDITY` with 0 liquidity → delta is fees only), *then* removes liquidity → delta is principal only. This is the same `feesAccrued` basis DefiLlama uses for SHROOM.
- Fees → `RevenueController.recordFees()`; principal → back to `principal` bucket. Principal never enters revenue.
- Guards: pool/token allowlist, max exposure per asset (in ETH value via oracle), slippage mins required, rebalance count/day limit, reject hooked pools unless hook allowlisted (hooks can skim fees).

### C. RevenueController
Period lifecycle: `Open → Proposed → Finalized → Allocated`.
- `Open`: fees accumulate per token from LiquidityManager (onchain-only source — can't be inflated by deposits).
- `propose(periodId, deductions[], evidenceURI)`: ACCOUNTANT books costs, reserve top-ups, realized LP losses, liabilities (per token, with evidence hash).
- `finalize`: after review window (e.g., 24h) — GOVERNOR/Safe confirms; snapshots oracle prices (value + source + timestamp) for reporting.
- `allocate`: for each token, `net = fees − deductions` (floor at 0; **negative carries forward** as `lossCarry` and reduces next periods).
- **Split rule:** split each token's net amount in-kind — `rewards = net*3000/10000`, `buyback = net*2000/10000`, `treasury = net − rewards − buyback` (remainder absorbs rounding → sum is exact, no dust lost). Splitting every token by the same ratio gives an exact 50/30/20 **by value** at any price, without needing an oracle to move money.
- Non-WETH tokens in the 30%/20% buckets are converted to WETH by OPERATOR via allowlisted routes with oracle-bounded `minOut`; quote vs realized logged.
- Guard: a period can be allocated once; fee IDs are consumed (no double counting).

### D. SqueeksRewardDistributor (Merkle, per epoch)
- Epoch funded with WETH from the 30% bucket.
- Offchain: snapshot Squeeks ownership at a fixed block on the NFT's home chain → leaves `(epoch, tokenId, owner, amount)` → root + full dataset published to IPFS.
- `postRoot(epoch, root, total, snapshotBlock, dataCID)` by ACCOUNTANT → **challenge window** (e.g., 48h, GUARDIAN can veto) → claimable.
- `claim(epoch, tokenId, owner, amount, proof)` → pays **ETH** (unwraps WETH) to the snapshot owner. Claimed bitmap keyed by **(epoch, tokenId)** → transferring the NFT can't double-claim.
- Batch `claimMany` for multi-NFT wallets. Contract-wallet owners supported (pay to `owner`, no `msg.sender` check needed). Optional: snapshot excludes known marketplace escrows, or maps escrowed NFTs to the depositor (decision).
- Unclaimed after N epochs (e.g., 6) → `sweepExpired` back into next epoch's reward pool (never to treasury).

### E. BuybackBurnExecutor
- Holds the 20% WETH budget.
- `execute(amountIn, minOut, deadline)` by OPERATOR; contract enforces `amountIn ≤ maxOrder`, daily cap, `minOut ≥ oracleQuote × (1 − maxSlippage)`, oracle fresh, pool liquidity ≥ floor, route allowlisted.
- Then `NUTS.burn(bought)` → **`totalSupply` decreases** (not a 0xdead transfer like SHROOM).
- Events: `BuybackExecuted(amountIn, nutsOut, oraclePrice, route)` and `TokensBurned(amount, newTotalSupply)`.
- MEV: small chunked orders, private RPC/bundler where the chain supports it.

### F. PriceOracle
- Per-token source config: Chainlink-style feed if available, else **TWAP** from an allowlisted pool. (Uniswap v4 pools have no built-in oracle → options: a v4 oracle hook on the NUTS/WETH pool, a v3 NUTS/WETH pool for observations, or a Safe-signed price with tight deviation bounds. **Decision needed.**)
- Staleness max age, max deviation between sources, min liquidity. Every read returns `(price, source, updatedAt)`.

### Events (spec schema)
`PositionOpened/Increased/Decreased/Closed`, `LPFeesCollected`, `AccountingPeriodFinalized`, `RevenueAllocated`, `RewardEpochCreated`, `RewardClaimed`, `BuybackExecuted`, `TokensBurned`, `TreasuryCapitalDeployed`, `EmergencyPaused/Unpaused` — plus `AllowlistUpdated`, `CapUpdated`, `RootPosted/Vetoed`.

---

## 3. Testing strategy

- **Unit** per contract (Foundry).
- **Fork tests** against real Uniswap v4 on the target chain (or Sepolia): open position → real swaps → collect → verify only fees collected.
- **Invariants (fuzzed):**
  - `treasury + rewards + buyback == net` for every allocation.
  - Sum of all revenue ever allocated ≤ sum of fees ever collected.
  - Principal bucket never decreases except by `decrease/close` returning to it.
  - No address without a role can move funds or change allowlists/caps/split.
  - Each (epoch, tokenId) claimable at most once; total claimed ≤ epoch funding.
- **Scenario sims (spec §8):** IL loss, zero/negative/tiny revenue, stale oracle, unsupported token, halted pool, hooked pool, paused distributor, NFT transfer mid-epoch, contract-wallet claimer.
- Indexer: replay test — numbers from Ponder must equal onchain reads exactly.

---

## 4. Milestones

| Milestone | Deliverables | Est. |
|---|---|---|
| **M0 — Feasibility** | Decisions below locked; interfaces frozen; architecture diagram; dependency list; mock NUTS + mock Squeeks for testnet | 1–2 wks |
| **M1 — Treasury + LP + accounting** | AccessController, TreasuryVault, LiquidityManager, UniV4Adapter, RevenueController, PriceOracle; unit + fork + invariant tests; testnet deploy script | 3–4 wks |
| **M2 — Rewards + buyback** | SqueeksRewardDistributor, Merkle tooling, BuybackBurnExecutor, WETH conversion flow; full end-to-end test on testnet | 3 wks |
| **M3 — Indexer + frontend** | Ponder indexer; web pages: Overview, Markets, Treasury, Rewards (claim), Buybacks; admin ops dashboard; ticker-hide env flag | 3 wks |
| **M4 — Security + limited launch** | Internal review, external audit, fixes; Safe/timelock role verification; public admin-powers doc; small-cap mainnet trial (one NUTS/WETH position) | 4–6 wks |
| **M5 — Expand** | Extra pools/assets one-by-one (stock tokens only after issuer/legal review); optional keeper automation | ongoing |

M1 and the frontend shell (M3, against mock indexer data) can run in parallel after M0.

---

## 5. Decisions needed (block final contracts, not M1 dev)

| # | Decision | Recommendation / note |
|---|---|---|
| 1 | Execution chain | **Resolved by Squeekchain docs: Ethereum.** Squeekchain is a toychain that *settles on Ethereum*, not its own EVM chain. Build on **Sepolia (11155111)** now, Ethereum mainnet later. Stock tokens: Robinhood's are not on Ethereum mainnet, so the stock-pair plan needs a separate issuer review (§5a) |
| 2 | NUTS token address & `burn()` support | Must expose `burn(uint256)` that reduces supply, or the "real burn" requirement fails |
| 3 | Squeeks NFT chain + contract | **Resolved: same chain.** SqueekNFT `0x0eAF3E0d40A0a8E5a6Ac030b2459E9FB0B7905c6` (Sepolia, immutable ERC-721). No bridge needed |
| 3b | Reward weight: 1 NFT = 1 unit, or by Squeek **power** | New, see §5a. Merges burn NFTs and power grows with level and staked SQK, so "1 NFT = 1" penalises merging |
| 4 | DEX + fee tier for NUTS/WETH | Uniswap v4, 0.3% or 1%, **no fee-skimming hook** |
| 5 | Oracle for NUTS | v4 oracle hook vs v3 pool TWAP vs signed price — pick before M2 |
| 6 | Net revenue definition | Confirm: per-token in-kind split; LP losses = realized only, carried forward |
| 7 | Epoch length & expiry | Monthly to start (gas vs size); expiry 6 epochs → roll forward |
| 8 | Escrowed / marketplace NFTs | Exclude, or map to depositor where provable |
| 9 | Multisig signers & threshold | ≥2-of-3; Guardian set; timelock 48h |
| 10 | Caps | Max per position, per asset, daily outflow, max buyback order, max slippage (bps) |
| 11 | Auditor | Book early — audit slots often run 4–8 weeks out |

---

## 5a. Squeekchain integration (from docs.squeekchain.com, 2026-10-22)

**What Squeekchain is:** a hamster-powered proof-of-work "toychain" that *settles on Ethereum*.
The WHEELY9000 wheel sensor reports work, a hardware-key Reporter signs it, a relayer settles it in
10-minute rounds to SqueekCore, and SqueekMining mints SQK per completed Squeek block (6,900 SQK at
launch, 2.1B cap, 10% premine) split across Squeeks' active power. Testnet only: Sepolia passed a
smoke test, **no mainnet**, **public minting paused**, and the contracts are "likely to change".

**Contract graph (Sepolia, chainId 11155111, index from block 11902282):**

| Contract | Address | Kind |
|---|---|---|
| SqueekCore (work ledger) | `0x74665dAecA35A2303e767E76a2FF1FB6F93e119f` | Transparent proxy, v3 |
| SqueekMining (rewards, positions) | `0x3beE588fC20dE788Bac17d33b41Da7346cb27EC4` | Transparent proxy, v6 |
| SqueekToken (SQK) | `0x6872bfa5ccc3e9e440c6c16e5ffdabb8dba4cc76` | Immutable ERC-20, **no burn** |
| SqueekNFT (Squeeks) | `0x0eAF3E0d40A0a8E5a6Ac030b2459E9FB0B7905c6` | Immutable ERC-721 + ERC-2981 |
| Governance timelock | `0x6B35AB6E96EF292E4fdD3f15a4E812f3CA291844` | 60 s delay (testnet) |
| Hamster-Owned Liquidity | `0x828cb04dbf0bdd8eb35d19045638a1af6e3d17e8` | Safe 1/1: premine, NFT sale proceeds, royalties |

Sources aren't verified on Etherscan, so decode with the ABIs Squeekchain publishes. Pin the ABIs and
check implementation hashes at startup, since both proxies can be upgraded.

**Squeek facts that change the distributor design:**
- **Levels and power:** level 1 = 1,000 power … level 10 = 1,023,000. Merging two same-level Squeeks
  **burns the donor** and levels up the survivor. Active power also depends on SQK staked to the Squeek.
  Per-position data is readable from SqueekMining (`activeWeight`, `level`).
- **Squeekchain's convention:** unclaimed rewards *travel with the NFT* on transfer.
- Squeekchain's SqueekFi page names "token distribution to Squeeks, e.g. in proportion to power" as a
  permissionless use case, so Nutshell fits the ecosystem without needing any approval.

**Distributor changes (supersedes §2-D details):**
1. **Weight options:** (a) 1 NFT = 1 unit, as in the spec, or (b) **active power at the snapshot block**,
   read from SqueekMining. (b) matches Squeekchain's own economics and doesn't penalise merging.
   Snapshot from archive-RPC state at a published block, so anyone can recompute it.
2. **Leaf = `(epoch, tokenId, amount)`, paid to `ownerOf(tokenId)` at claim time.** Rewards travel with
   the NFT, the same as SQK. No owner address goes in the leaf, double claims are blocked by the
   (epoch, tokenId) bitmap, and escrow or marketplace holders are handled naturally.
3. **Burned donors** (merged after the snapshot) can't claim, so their share expires and rolls into
   the next epoch.
4. **Gas on Ethereum L1:** use monthly epochs, `claimMany` for up to 32 IDs, and leave epochs
   claimable across months.

**New market idea:** **NUTS/SQK** pool. SQK is the ecosystem's native token, and the Hamster-Owned
Liquidity already holds the SQK premine for liquidity. Coordinate with the Squeekchain team so
Nutshell and the Hamster-Owned Liquidity don't compete for the same pools.

**Timing risk:** SqueekNFT minting is paused and there's no mainnet date. Rewards need Squeeks with
owners, so M2 testing will use a **mock SqueekNFT/SqueekMining on Sepolia or Anvil** until real
mints happen.

---

## 6. Lessons applied from SHROOM

| SHROOM onchain | Nutshell |
|---|---|
| 1-of-3 Safe, no timelock | ≥2-of-3 Safe + 48h timelock, role separation |
| Burns = manual lump transfers to 0xdead | Executor with caps/oracle bounds → `burn()` reduces supply |
| No onchain split or accounting | RevenueController enforces 50/30/20 per finalized period |
| Treasury wallet mixes memecoins / farming | Strict token/pool/router allowlists |
| Holder rewards depend on third-party launchpad hook | Own distributor, funded only from Nutshell revenue |
| Hooked genesis pool takes fees | Reject non-allowlisted hooks |
| v4 positions held in Safe, fees tracked via `feesAccrued` | **Keep** — same model, enforced in contracts |
