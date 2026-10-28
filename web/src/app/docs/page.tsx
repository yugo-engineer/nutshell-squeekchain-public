"use client";
/**
 * /docs - how the hub works, in the order a reader asks: where the money comes from, where it
 * goes, how a Squeek gets paid, and how to check every claim on this page yourself.
 *
 * Same rule as the home page: values that live on chain (claim delay, claim window, pause) are
 * read from the hub, never typed in here. Only the contract's constants are written out.
 */
import { useEffect, useState } from "react";
import { stringToHex } from "viem";
import { CONFIG, TOKEN, TOKEN_SHORT } from "@/lib/config";
import { HUB, NUTS, explorer, publicClient } from "@/lib/chain";
import { NA } from "@/lib/format";
import { NUTSHELL_ABI } from "@/lib/nutshell-abi";
import { SiteFooter, SiteHeader } from "@/components/Site";

const TOC = [
  ["overview", "Overview"],
  ["split", "The fee split"],
  ["fees", "Fees vs principal"],
  ["buckets", "Untouchable buckets"],
  ["rewards", "Squeeks rewards"],
  ["claiming", "Claiming"],
  ["burn", "Buyback & burn"],
  ["pools", "Pools"],
  ["presale", "Genesis presale"],
  ["roles", "Who can do what"],
  ["verify", "Verify it yourself"],
  ["contracts", "Contracts"],
  ["risks", "Risks"],
] as const;

type Cfg = { claimDelay: bigint; epochTtl: bigint; paused: bigint; rewardsBps: bigint; buybackBps: bigint; maxSwapBps: bigint } | null;

/** cfg keys are ASCII names right-padded to bytes32, exactly as Nutshell.sol declares them. */
const key = (s: string) => stringToHex(s, { size: 32 });

function useCfg(): Cfg {
  const [cfg, setCfg] = useState<Cfg>(null);
  useEffect(() => {
    if (!HUB) return;
    publicClient
      .readContract({
        address: HUB,
        abi: NUTSHELL_ABI,
        functionName: "getCfg",
        args: [[key("claimDelay"), key("epochTtl"), key("paused"), key("rewardsBps"), key("buybackBps"), key("maxSwapBps")]],
      })
      .then((v) => {
        const [claimDelay, epochTtl, paused, rewardsBps, buybackBps, maxSwapBps] = v as readonly bigint[];
        setCfg({ claimDelay, epochTtl, paused, rewardsBps, buybackBps, maxSwapBps });
      })
      .catch(() => setCfg(null));
  }, []);
  return cfg;
}

function duration(s: bigint | undefined): string {
  if (s === undefined) return NA;
  const n = Number(s);
  if (n === 0) return "not set";
  if (n % 86_400 === 0) return `${n / 86_400} day${n === 86_400 ? "" : "s"}`;
  if (n % 3_600 === 0) return `${n / 3_600} hours`;
  if (n % 60 === 0) return `${n / 60} minutes`;
  return `${n} seconds`;
}

function Addr({ label, a, note }: { label: string; a: string | null; note: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        {a ? (
          <a href={explorer("address", a)} target="_blank" rel="noreferrer"><code>{a}</code></a>
        ) : (
          <span className="muted">{NA}</span>
        )}
      </td>
      <td className="muted">{note}</td>
    </tr>
  );
}

export default function Docs() {
  const cfg = useCfg();
  const nuts = CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "the token";
  // Live split; before the read lands, the tokenomics doc's defaults.
  const r = cfg ? Number(cfg.rewardsBps) / 100 : 35;
  const b = cfg ? Number(cfg.buybackBps) / 100 : 15;
  const t = 100 - r - b;

  return (
    <>
      <SiteHeader />
      <main className="docs wrap">
        <header className="shead docs__head">
          <p className="mono-label"><span className="bracket">[ Docs ]</span> How the hub works</p>
          <h1>How it <mark>works.</mark></h1>
          <p className="lead">
            Everything Nutshell does happens in one contract, the hub. This page explains what it holds, where every
            fee goes and how Squeeks owners get paid - and points at the on-chain data that proves each line.
          </p>
        </header>

        <div className="docs__grid">
          <nav className="docs__toc" aria-label="On this page">
            <div className="card__tag">On this page</div>
            <ol>
              {TOC.map(([id, label], i) => (
                <li key={id}><a href={`#${id}`}><b>{String(i + 1).padStart(2, "0")}</b>{label}</a></li>
              ))}
            </ol>
          </nav>

          <article className="docs__body">
            <section id="overview">
              <h2>Overview</h2>
              <p>
                Nutshell is protocol-owned liquidity for the Squeekchain ecosystem. The hub opens and manages its own
                Uniswap v4 positions - {TOKEN} pairs first, and any other pool worth earning fees in. Traders pay fees to use that liquidity; the hub
                collects them and splits every fee the moment it lands. Nobody deposits into Nutshell and nobody is
                promised a yield - it earns only from liquidity it owns, and only as much as traders actually pay.
              </p>
              <p>
                Squeekchain is a toychain that settles on Ethereum, so Nutshell lives on Ethereum too: {CONFIG.CHAIN_NAME}{" "}
                today, mainnet once Squeekchain&apos;s mainnet contracts exist.
              </p>
            </section>

            <section id="split">
              <h2>The fee split</h2>
              <div className="split__bar" role="img" aria-label={`${t}% treasury, ${r}% Squeeks rewards, ${b}% buyback and burn`}>
                <div className="split__t" style={{ width: `${t}%` }}>{t}% TREASURY</div>
                {r > 0 && <div className="split__r" style={{ width: `${r}%` }}>{r}% SQUEEKS</div>}
                {b > 0 && <div className="split__b" style={{ width: `${b}%` }}>{b}% BURN</div>}
              </div>
              <dl className="docs__dl">
                <div><dt className="blue">Treasury · {t}%</dt><dd>Stays in the hub as free capital, redeployable into more or larger positions.</dd></div>
                <div><dt className="gold">Squeeks rewards · {r}%</dt><dd>Goes into the rewards bucket and is paid out in ETH to Squeeks owners, epoch by epoch.</dd></div>
                <div><dt>Buyback &amp; burn · {b}%</dt><dd>Goes into the buyback bucket, is swapped into {TOKEN_SHORT} and burned.</dd></div>
              </dl>
              <p>
                The split is configuration (<code>rewardsBps</code>, <code>buybackBps</code>), read live above from the
                hub. The owner or operator can change it, but only inside bounds the contract enforces: Squeeks rewards
                at most <b>35%</b>, and rewards plus burn at most <b>50%</b> - so the treasury, which gets the
                remainder, always keeps at least half. A change applies to fees collected after it, never to fees
                already split.
              </p>
            </section>

            <section id="fees">
              <h2>Fees vs principal</h2>
              <p>
                The liquidity in a position is principal. Fees are revenue. Only revenue is ever split - principal is
                never paid out as rewards or burned.
              </p>
              <p>
                Fees reach the split through exactly one path: a <em>zero-liquidity decrease</em> on the position.
                Removing zero liquidity returns the position&apos;s accrued fees and nothing else, so the amount the hub
                measures cannot contain principal. Increasing, decreasing or closing a position always collects first,
                so fees are never folded into the position or handed back as principal.
              </p>
              <p>
                <code>collectFees</code> is permissionless. Since collected fees can only go into the split, anyone may
                trigger it for any live position.
              </p>
            </section>

            <section id="buckets">
              <h2>Untouchable buckets</h2>
              <p>The hub&apos;s balance of any token is three things at once:</p>
              <pre className="docs__code">balance = free capital + rewards bucket + buyback bucket (+ ETH reserved for open epochs)</pre>
              <p>
                Only free capital (principal plus the treasury&apos;s share) is the treasury&apos;s to move. Every function that
                spends - opening or increasing a position, swapping a bucket or treasury capital, withdrawing - re-checks after it runs
                that the balance still covers both buckets and every reserved epoch. If it doesn&apos;t, the whole
                transaction reverts. That check is what keeps the Squeeks&apos; ETH and the burn budget out of reach of
                the owner and the operator, whatever amount they ask for.
              </p>
            </section>

            <section id="rewards">
              <h2>Squeeks rewards</h2>
              <p>
                Rewards are paid in <b>epochs</b>. To open one, the operator takes a snapshot of every live Squeek&apos;s
                power (its <code>activeWeight</code> in SqueekMining) at a chosen block, splits an amount of the rewards
                bucket pro rata to power, and builds a Merkle tree over the result. The full data set is published
                before the epoch is posted, so anyone can rebuild the tree and check their share.
              </p>
              <p>
                Posting an epoch moves its total out of the rewards bucket into reserved ETH. From there it goes
                through three phases:
              </p>
              <ol className="docs__steps">
                <li>
                  <b>Review</b> - lasts <span className="docs__live">{duration(cfg?.claimDelay)}</span>. The published
                  data can be checked; the operator can still cancel the epoch, which returns its ETH to the rewards
                  bucket.
                </li>
                <li>
                  <b>Claimable</b> - lasts <span className="docs__live">{duration(cfg?.epochTtl)}</span>. Each Squeek can
                  be claimed once. The epoch can no longer be cancelled.
                </li>
                <li>
                  <b>Expired</b> - anyone may call <code>closeEpoch</code>. Whatever was not claimed goes back to the
                  rewards bucket and rolls into a future epoch. If we ever decide otherwise, the operator can move part
                  of the rewards bucket to the treasury with <code>sweepRewards</code> - a deliberate, logged step,
                  never automatic.
                </li>
              </ol>
              <p className="muted">
                Durations above are read live from the hub on {CONFIG.CHAIN_NAME}. The hub refuses to post an epoch
                whose claim window is shorter than 1 day, and the review delay is capped at 30 days.
              </p>
            </section>

            <section id="claiming">
              <h2>Claiming</h2>
              <ul className="docs__list">
                <li><b>Rewards travel with the NFT.</b> A claim pays whoever owns the Squeek at claim time, not whoever owned it at the snapshot. Sell a Squeek with unclaimed rewards and the buyer can claim them.</li>
                <li><b>Anyone can claim for anyone.</b> The ETH can only go to the Squeek&apos;s current owner, so a claim sent by someone else still pays you.</li>
                <li><b>One claim per Squeek per epoch.</b> Claimed status is keyed by (epoch, Squeek id). Many Squeeks fit in one transaction.</li>
                <li><b>Claiming is never paused.</b> The pause switch does not reach <code>claim</code>.</li>
                <li><b>Merged-away Squeeks.</b> A Squeek burned in a merge has no owner, so its share can&apos;t be claimed; it returns to the rewards bucket when the epoch closes.</li>
              </ul>
              <p>
                The <a href="/rewards">Rewards</a> page finds the Squeeks in your wallet, shows each
                open epoch and what it owes you, and claims them in one transaction.
              </p>
            </section>

            <section id="burn">
              <h2>Buyback &amp; burn</h2>
              <p>
                The {b}% share of any fee paid in {nuts} is burned on the spot. The {b}% share of fees in any other token
                (ETH for the primary pool; a stablecoin or stock token for other pools) sits in the buyback bucket until
                the operator swaps it into {nuts} through allowlisted pools - in more than one hop if needed; the {nuts}
                bought is burned in the same transaction.
              </p>
              <p>
                Burning calls the token&apos;s <code>burn()</code>, so total supply goes down on chain. Sending tokens to
                a dead address is not a burn and the hub never does it. Every burn emits <code>TokensBurned</code> with
                the supply after it; the burn log on the <a href="/dashboard">Dashboard</a> lists each one with its transaction.
              </p>
              <p>
                Every swap takes a non-zero minimum output, and the hub measures what it actually received rather
                than trusting the swap adapter&apos;s answer. A swap may also be capped at a share of its source balance
                (<code>maxSwapBps</code>, now <span className="docs__live">{cfg ? (cfg.maxSwapBps === 0n ? "no cap" : `${Number(cfg.maxSwapBps) / 100}%`) : NA}</span>).
              </p>
            </section>

            <section id="pools">
              <h2>Pools</h2>
              <p>
                The hub only touches pools on its allowlist, which the owner or operator maintains. Any pool can be
                listed: {TOKEN} / stock tokens and {TOKEN} / ETH first, but also stock / stablecoin, SQK / ETH or any
                other market worth earning fees in.
              </p>
              <ul className="docs__list">
                <li><b>Hooks are allowed, so vet them.</b> A hook is code that runs inside every swap and liquidity change and can take part of the fee. The contract no longer refuses hooked pools; each hook is reviewed before its pool is listed.</li>
                <li><b>Conversions use the allowlist too.</b> Fees earned in a stablecoin or stock token reach ETH (for rewards) or {nuts} (for the burn) only through allowlisted pools.</li>
              </ul>
              <p>
                The live market is {CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "the token"} / ETH at a{" "}
                {CONFIG.PRIMARY_POOL.feeBps / 100}% fee tier. Tokenized stock pairs shown on the home page are research
                only: none is deployed or allowlisted.
              </p>
            </section>

            <section id="presale">
              <h2>Genesis presale</h2>
              <p>
                A separate contract, <code>NutsPresale</code>, runs two back-to-back phases paid in ETH. The team opens
                phase 1 with a contract call; phase 2 follows automatically. Progress is
                measured in time, not money raised, and Nutshell launches whether or not the presale fills.
              </p>
              <ol className="docs__steps">
                <li><b>Phase 1 - Squeeks holders.</b> Wallets in a published snapshot of Squeeks owners. One hour, or until 10% of the supply is sold.</li>
                <li><b>Phase 2 - everyone.</b> Starts the moment phase 1 ends. One hour, or until 8.57% of the supply plus whatever phase 1 left unsold is sold.</li>
                <li><b>TGE.</b> Buyers claim 100% of their {nuts}. Tokens that never sold go to the treasury.</li>
              </ol>
              <ul className="docs__list">
                <li><b>Price:</b> $350,000 FDV over 1,000,000,000 {nuts} = $0.00035 each, converted at an ETH/USD rate the operator sets.</li>
                <li><b>Limits:</b> $500 to $3,500 per wallet, across both phases.</li>
                <li><b>Where the ETH goes:</b> straight to the hub as treasury capital, in the same transaction. The presale contract never holds ETH.</li>
                <li><b>Terms freeze at the start.</b> Supply, FDV, caps and durations can&apos;t change once phase 1 begins.</li>
              </ul>
              <p>The <a href="/presale">Presale</a> page shows the live phase, its clock and the buy form.</p>
            </section>

            <section id="roles">
              <h2>Who can do what</h2>
              <div className="table-wrap">
                <table className="table docs__table">
                  <thead><tr><th>Role</th><th>Can</th><th>Cannot</th></tr></thead>
                  <tbody>
                    <tr>
                      <td>Owner</td>
                      <td>Everything the operator can, plus: set addresses (token, Squeeks NFT, Uniswap contracts, swap adapter), appoint the operator, withdraw free capital, move the presale&apos;s treasury address.</td>
                      <td>Touch the buckets or reserved epoch ETH, push the split past its bounds, stop claims.</td>
                    </tr>
                    <tr>
                      <td>Operator</td>
                      <td>Open, increase, decrease and close positions; swap buckets and treasury capital; list and delist pools; set the split, swap cap, epoch timing and pause; post and cancel epochs; sweep rewards to the treasury; run the presale (terms, schedule, rate, whitelist, TGE claims).</td>
                      <td>Change any address, withdraw anything, spend bucket funds outside their own bucket.</td>
                    </tr>
                    <tr>
                      <td>Anyone</td>
                      <td>Collect fees, close expired epochs, claim for any Squeek.</td>
                      <td>Choose where fees or claims go - the contract decides.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p>
                Ownership transfers in two steps (propose, then accept). The owner is meant to become a multisig Safe
                before the hub holds real value. Pausing stops new positions, increases, bucket swaps and new epochs -
                never claims. Right now the hub is{" "}
                <span className="docs__live">{cfg ? (cfg.paused ? "PAUSED" : "NOT PAUSED") : NA}</span>.
              </p>
            </section>

            <section id="verify">
              <h2>Verify it yourself</h2>
              <p>Every number on this site is a contract read. To check a reward epoch end to end:</p>
              <ol className="docs__steps">
                <li>Read the epoch with <code>epoch(id)</code>: root, total, snapshot block, claim window.</li>
                <li>Download the published data set from <code>{CONFIG.EPOCHS_BASE}/&lt;root&gt;/</code> on this site.</li>
                <li>Re-read each Squeek&apos;s <code>activeWeight</code> from SqueekMining at the snapshot block and check the amounts are pro rata.</li>
                <li>Rebuild the tree and compare its root with the one on chain.</li>
              </ol>
              <p>Each leaf is the OpenZeppelin double hash, so a leaf can never pass as an inner node:</p>
              <pre className="docs__code">leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, squeekId, amount))))</pre>
              <p>Inner nodes hash the sorted pair: <code>keccak256(min(a, b) ‖ max(a, b))</code>.</p>
              <p>Events worth indexing:</p>
              <ul className="docs__list docs__list--mono">
                <li>LPFeesCollected(tokenId, fee0, fee1)</li>
                <li>RevenueAllocated(token, amount, treasury, rewards, buyback)</li>
                <li>RewardEpochCreated(epochId, root, total, snapshotBlock, claimableAt, expiresAt)</li>
                <li>RewardClaimed(epochId, squeekId, to, amount)</li>
                <li>RewardEpochClosed(epochId, released, cancelled)</li>
                <li>BuybackExecuted(tokenIn, amountIn, nutsOut)</li>
                <li>TokensBurned(amount, totalSupplyAfter)</li>
                <li>TreasurySwapped(tokenIn, tokenOut, amountIn, amountOut)</li>
                <li>RewardsSwept(token, amount)</li>
                <li>Bought(buyer, phase, paidWei, usd, tokens) - presale</li>
              </ul>
            </section>

            <section id="contracts">
              <h2>Contracts · {CONFIG.CHAIN_NAME}</h2>
              <div className="table-wrap">
                <table className="table docs__table">
                  <thead><tr><th>Contract</th><th>Address</th><th>Role</th></tr></thead>
                  <tbody>
                    <Addr label="Nutshell hub" a={HUB} note="Every position, all capital, both buckets" />
                    <Addr label={CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "Token"} a={NUTS} note="Test token on Sepolia" />
                    <Addr label="Genesis presale" a={CONFIG.PRESALE_ADDRESS || null} note="Two timed phases; ETH goes to the hub" />
                    <Addr label="Squeeks NFT" a={CONFIG.SQUEEK_NFT_ADDRESS} note="Who gets paid (ownerOf)" />
                    <Addr label="SqueekMining" a={CONFIG.SQUEEK_MINING_ADDRESS} note="Squeek power, read off chain at the snapshot" />
                  </tbody>
                </table>
              </div>
              <p className="muted">The hub never calls SqueekMining itself; only the off-chain snapshot reads it.</p>
            </section>

            <section id="risks">
              <h2>Risks</h2>
              <ul className="docs__list">
                <li>This is testnet software and has not been audited.</li>
                <li>Rewards follow actual fees. Low trading volume means small or no epochs. There is no guaranteed yield.</li>
                <li>Liquidity positions carry price risk; the treasury&apos;s capital can lose value.</li>
                <li>Epoch amounts come from an off-chain snapshot. The review window and the published data set exist so it can be checked before anyone can claim.</li>
              </ul>
              <p className="muted">Nothing here is investment advice or a promise of returns.</p>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

