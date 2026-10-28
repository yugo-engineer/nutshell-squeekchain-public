# Nutshell - working rules

Protocol-owned Uniswap v4 liquidity around NUTS, built for the Squeekchain ecosystem on
**Ethereum** (Sepolia now, mainnet later - Squeekchain is a toychain that *settles on* Ethereum,
not its own EVM chain). Every collected LP fee is split the moment it lands: **at least 50%
treasury / up to 35% Squeeks rewards / 15% NUTS buyback & burn** (the tokenomics doc; the
split is config inside contract-enforced bounds). A separate contract runs the Genesis presale.

Architecture reference: `E:\CODE\z_CODE\nftlaunchpad2` (one hub, a config map, adapters for
anything that runs inside `PoolManager.unlock`, `server/config.ts` as the single source of truth).

## The four contracts

| Contract | Deployed | Holds |
|---|---|---|
| `Nutshell.sol` | once | every knob, every position NFT, all capital and both buckets |
| `V4SwapAdapter.sol` | once per hub | nothing between calls |
| `NutsToken.sol` | Sepolia only | test NUTS; the real launch token is out of scope |
| `NutsPresale.sol` | once | nothing: every wei goes to the hub in the same tx; NUTS for TGE claims |

There is **no** governance contract, timelock, oracle, accounting contract, indexer contract or
separate rewards distributor. The spec's seven modules collapse into `Nutshell.sol`.

## The rules that are not negotiable

- **The split is config with hard bounds.** `rewardsBps` <= 3500 and `rewardsBps + buybackBps`
  <= 5000, so the treasury (the remainder) always keeps at least half. Defaults from the doc:
  3500 / 1500. A change applies only to fees collected after it. 0 / 0 = all to treasury.
- **Fees reach the buckets ONLY through `_collect`**, a zero-liquidity decrease. Its balance
  delta cannot contain principal. `increase/decrease/close` all collect first so fees are never
  folded into or returned as principal.
- **Every spend re-checks `balance >= rewardsBal + buybackBal (+ epochReserved for ETH)`**
  afterwards (`_requireCovered`). That is what makes the buckets untouchable by the owner and
  the operator. Do not add a spending path without it.
- **NUTS bought or received by the buyback share is burned with `burn()`** - totalSupply goes
  down. A transfer to 0xdead is not a burn.
- **Any pool may be allowlisted** - NUTS/stock and NUTS/ETH first, but stock/stable, SQK/ETH or
  anything else too, hooked or not. A hook can take part of every fee: vet it before listing.
  `POOLS` entries take `base` (defaults to NUTS) and `hooks` (defaults to none).
- **Operator vs owner.** The operator runs everything day to day: positions, bucket and treasury
  swaps, the pool allowlist, the economic cfg keys (split, `maxSwapBps`, epoch timing, pause),
  epochs, `sweepRewards`, and the presale. Only the owner sets ADDRESS keys, appoints the
  operator, withdraws free capital and moves the presale treasury. Keep it that way: an operator
  that could repoint `squeekNft` or `swapAdapter` could drain the buckets.
- **Expired epochs roll back into the rewards bucket.** `sweepRewards` moves part of that
  bucket to the treasury only when the operator calls it.
- **Presale:** phase 1 (Squeeks snapshot) 1 hour or until 10% sells; phase 2 (anyone) starts
  when phase 1 ends, 1 hour or until 8.57% + phase 1's unsold sells. $500-$3,500 per wallet,
  ETH at an operator-set rate. No soft cap, no refunds; ETH goes straight to the hub; 100%
  claimable at TGE. Phase 1 starts only when the operator calls `startPhase1()`; phase 2 opens by
  itself when phase 1 ends. Progress on the site is TIME-based, never amount raised.
- **`claim` is never paused**, and pays `ownerOf(squeekId)` at claim time - rewards travel with
  the NFT, like Squeekchain's own SQK. Claimed bits are keyed by `(epochId, squeekId)`.
- **Rewards are weighted by Squeek power** (SqueekMining `activeWeight`) at a published snapshot
  block. The hub never calls SqueekMining; only the off-chain snapshot does.
- **Config is one `mapping(bytes32 => uint256)`** keyed by ASCII names. A zero value means "not
  configured yet" and must stay writable - validate floors where the value is USED (see
  `epochTtl` in `postEpoch`), not in `setCfg`, or the first single-key push reverts.
- **`server/config.ts` is the single source of truth, and `CHAIN_CFG` + `POOLS` in it ARE the
  desired chain state.** `npm run config:push` diffs and writes only what differs.
- **The deployer private key lives in `server/secrets.ts`, which is GITIGNORED.** `server/config.ts`
  imports it. Never import either from web/, never print the key. `npm run keygen` creates it.
- Contracts have **no external dependencies**. Relative imports inside `contracts/` only.
- Foundry is for **tests only**, run in Docker (`scripts/forge.mjs`). Deployment uses the solc-js
  artifacts from `npm run contracts:compile`; re-run it after any `.sol` edit.
  `foundry.toml` must mirror `scripts/compile-contracts.mjs` (solc 0.8.35, optimizer 200,
  evm_version **cancun**, via_ir off).
- **Ethereum's 24,576-byte limit is real here.** Nothing is suppressed. Nutshell is 20,810 B, NutsPresale 8,177 B.
- Addresses are only added after verifying them on chain (code present, and a cross-check such
  as `PositionManager.poolManager()`). Note the check next to the address in config.

## Commands

```bash
npm test                     # unit suite (Docker)
npm run test:fork            # full money path against live Uniswap v4 on Sepolia
npm run contracts:compile    # solc-js -> server/utils/*-artifact.ts
npm run keygen               # fresh deployer key into server/config.ts
npm run contracts:deploy:dry # gas + cost, spends nothing, needs no key
npm run contracts:deploy     # deploy + write addresses back into config
npm run config:push:dry      # show cfg/pool drift
npm run config:push          # write it
npm run seed                 # TESTNET: pool + position + test trades + collect + buyback

npm run presale -- configure            # push PRESALE terms + ETH/USD (before start)
npm run presale -- whitelist [--block N] # Squeeks owners snapshot -> root; then redeploy the site
npm run presale -- start                # operator opens phase 1 NOW; phase 2 follows automatically
npm run presale -- rate 2450             # update ETH/USD, e.g. as phase 2 opens
npm run presale -- open-claims           # after the sale: fund with sold NUTS, open TGE claims
npm run status               # read-only snapshot
```

## Reward epochs

```bash
npm run epoch -- --amount 0.5                  # snapshot power, build tree -> epochs/epoch-<id>-<block>.json
npm run epoch -- --post epochs/epoch-0-N.json  # postEpoch from the owner key
npm run fixture:merkle                         # regenerate the TS<->Solidity tree cross-check
```

`scripts/lib/merkle.ts` must stay byte-compatible with `Nutshell._verify`;
`test/MerkleFixture.t.sol` proves it. The epoch JSON is the published data set (~8.5 MB for
7,346 Squeeks) - publish it before posting. Measured 2026-10-22 on Sepolia: 7,346 live Squeeks
(matches SqueekNFT.totalSupply), total power 10,630,000, 213 owners, power 1,000 to 127,000.

## Frontend (`web/`)

Its own Next.js package (static export), deployed as a Cloudflare static-assets Worker:
https://nutshell.engineering0.workers.dev

```bash
cd web && npm run dev      # http://localhost:3000
cd web && npm run deploy   # next build -> out/ -> wrangler deploy
```

- `web/src/lib/config.ts` is the client-safe mirror of `server/config.ts`. `web/` NEVER imports
  from `server/`. `contracts:deploy` patches its addresses; `contracts:compile` writes
  `web/src/lib/nutshell-abi.ts`.
- `npm run epoch` writes the claim buckets the site reads into `web/public/epochs/<root>/`, so
  redeploy the site after building an epoch and before posting it.
- Look: the nutshell-fi site (https://nutshell-fi.vercel.app), layout and styling both: ivory /
  ink / amber / blue tokens swapped by `.t-light` and `.t-dark` bands, Syne headlines, Geist body,
  small tracked uppercase Martian Mono labels, square hairline panels, chamfered `.btn`s, the
  specimen key art (`public/hero.webp`, `acorn.webp`). Scroll reveals hang off `html.motion`
  (set by `useMotion` in `Site.tsx`), so nothing is hidden without JS or with reduced motion.
- Pages: `/` (hero, why, model, revenue), `/markets`, `/presale`, `/rewards`, `/dashboard`, `/docs`.
  Nav links point at the pages, not at `/#anchors`.
- Every number is a contract read; missing data renders NOT AVAILABLE. `SHOW_TICKER` hides the
  token ticker until it is announced.
- `/admin` (unlinked, noindex) is the operator console: pools/positions with uncollected fees,
  buckets, cfg drift, epochs, presale + buyers, roles, and every owner/operator write through one
  dialog that simulates first. Shown only to the hub/presale owner or operator - a cosmetic gate;
  the contracts enforce roles. Drift is measured against `CONFIG.ADMIN` in `web/src/lib/config.ts`,
  a HAND-KEPT mirror of `CHAIN_CFG`, `POOLS` and `PRESALE`: edit it whenever you edit those.

## Not built yet

- Operator scripts: size a position from StateView, open/increase, quote + `swapBucket`.
- Squeekchain mainnet addresses - none exist yet; `DEPLOY = true` is blocked until they do.
