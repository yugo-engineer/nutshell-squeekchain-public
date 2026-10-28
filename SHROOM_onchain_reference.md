# SHROOM — onchain architecture reference (for Nutshell)

Collected 2026-10-21 from Robinhood Chain (chainId 4663) via Blockscout, public RPC
(robinhood-rpc.publicnode.com) and DefiLlama adapters
(`dimension-adapters/fees/shroom.ts`, `fees/shroom-treasury.ts`).

## Addresses

| Role | Address | Type |
|---|---|---|
| SHROOM token | `0xab093dEF657F15dF31b33922A95e047aDd645B29` | `PonsV2LauncherToken` (verified, not a proxy). ERC-20 + `burn` / `burnFrom`, launched via the Pons launchpad bonding curve |
| Genesis pool hook | `0xe5e702641Ea86F4ae6cC3cDaeD2B886F976bE044` | `PonsV2MemeHook`, a Uniswap v4 hook shared by all Pons launches |
| Genesis pool | poolId `0xbacecf78…73f6eb` | SHROOM/MU v4 pool, fee 0, tickSpacing 200, hooked |
| MU dividend distributor | `0xEa4036B0FccDB5F90421D5b9c35E05758e40Ce18` | BeaconProxy (Pons, shared) |
| MU (Micron stock token) | `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` | BeaconProxy → `Stock` implementation (Robinhood) |
| Treasury A (main LP vault) | `0xfca196eacf630f67b505023c4f2cf7eb36da2f9f` | Gnosis **SafeL2, threshold 1 of 3** |
| Treasury B (ops wallet) | `0xad5bc794c2829e671a7f5c135ca85ff97a62638b` | EOA upgraded via **EIP-7702** (MetaMask `EIP7702StatelessDeleGator`) |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | |
| Uniswap v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` | |

Safe owners: `0xa7cbdc13…b65e`, `0x70af5a33…eaa3`, `0x36f4e180…7246`.

## Token state
- Name "MUSHROOM", 18 decimals, about 11.1k holders.
- Total supply 999,860,638. About 139k was reduced through `burn()`.
- **15,183,026 SHROOM at `0x…dEaD`.** This is the main burn route. It is a plain transfer to the dead address, not a supply reduction.

## Flow 1: genesis pool → MU dividends to SHROOM holders (Pons, not Shroom code)
- `PonsV2MemeHook` charges a **1% hook fee plus about 3.33% tax** on every SHROOM/MU swap.
- On a sweep it emits `PoolFeesSwept(poolId, protocolAmount, buybackAmount, creatorAmount, tokensLocked)`, everything in MU.
- Pons takes `protocolFeeShareBps` = 30% of the hook fee. The rest (creatorAmount) goes to the distributor as **MU dividends paid pro-rata to all SHROOM holders**.
- The hook has buyback and lock fields, but SHROOM uses neither (both are 0).

## Flow 2: protocol-owned liquidity → buyback & burn (Shroom treasury)
- The Safe holds **157 UNI-V4-POSM position NFTs** plus 1 v3 position. The EOA holds 5 v4 positions and 2 Ekubo positions.
- The pairs are SHROOM against stock tokens and others (MCD, RVH, AVNT, leveraged stock tokens such as NVDAx3L and OPENAIx1L, WETH and USDG).
- Operations are Safe `execTransaction` → `MultiSendCallOnly` batches → Permit2 + `PositionManager.modifyLiquidities` (mint, increase or collect). New positions were minted almost daily through October.
- Fees are counted as `feesAccrued` returned by `PoolManager.modifyLiquidity` on treasury-owned positions. DefiLlama reports about $780k in September and $35k so far in October, and explicitly excludes principal.
- **Burns are manual lump transfers to 0xdead from the Safe:** 1M on 09-09, 500k on 09-12 and 1M on 10-10. There is also 12.5M (09-05, from the launch or bonding-curve contract) and 182k from the EOA.
- There is **no buyback contract, no onchain revenue split, no accounting contract and no timelock**. Everything runs at the multisig signers' discretion.

## Takeaways for Nutshell
1. **Reuse:** Uniswap v4 PositionManager for positions, Safe + MultiSend for execution, and position NFTs held by the treasury so fee attribution can be audited (DefiLlama's method of reading `feesAccrued` and reconstructing ownership is a good spec for our indexer).
2. **Do better (our spec already requires it):**
   - 1-of-3 Safe → use at least 2-of-3 plus a timelock.
   - Manual, ad hoc burns → `BuybackBurnExecutor` with events, oracle bounds and a real `burn()` that lowers supply.
   - No split enforcement → `RevenueController` with an exact 50/30/20 split and finalized periods.
   - The EOA mixes in unrelated memecoins and farming → keep a strict asset allowlist in `TreasuryVault`.
3. **Holder rewards differ:** SHROOM's MU dividend comes from Pons launchpad hook fees, outside Shroom's control. Nutshell's Squeeks ETH rewards come from its own revenue, so the distributor must be our own contract.
4. **Stock tokens are Robinhood Chain assets** (Robinhood `Stock` BeaconProxy, upgradeable by the issuer). The stock-pair plan only works on that chain, and issuer upgrades or transfer restrictions are a risk to model.
