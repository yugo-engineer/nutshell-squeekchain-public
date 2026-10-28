"use client";
/**
 * /rewards - Squeeks reward epochs: what each open epoch owes the Squeeks in the connected wallet,
 * and the claim. Claims are never paused and pay ownerOf(squeekId) at claim time.
 */
import { useProtocol } from "@/lib/useProtocol";
import { Icon, Kicker, SiteFooter, SiteHeader, useMotion } from "@/components/Site";
import { Rewards } from "@/components/Rewards";

export default function RewardsPage() {
  useMotion();
  const p = useProtocol();
  // Live split from the hub's config; before it loads, the tokenomics doc's defaults.
  const sp = p.split ?? { treasury: 50, rewards: 35, buyback: 15 };
  return (
    <>
      <SiteHeader />

      <main id="top">
        <section id="rewards" className="t-dark band">
          <div className="wrap">
            <header className="shead" data-reveal>
              <Kicker>Squeeks rewards</Kicker>
              <h1>Own a Squeek. Earn the ETH.</h1>
              <p className="lead">
                {sp.rewards}% of every fee is paid in ETH to Squeeks owners, weighted by each Squeek&apos;s power at a published
                snapshot block. Rewards travel with the NFT. No guaranteed yield: payouts follow actual fees.
              </p>
            </header>
            <div className="tokenomics">
              <Rewards epochs={p.epochs} onClaimed={p.refresh} />
              <article className="panel" data-reveal>
                <p className="mono-label">How a claim works</p>
                <ul className="checks">
                  <li><Icon name="check" /><span><b>Connect</b> the wallet holding your Squeeks.</span></li>
                  <li><Icon name="check" /><span><b>See each open epoch</b> and what it owes every Squeek you own.</span></li>
                  <li><Icon name="check" /><span><b>Claim ETH,</b> one transaction per epoch. Claims are never paused.</span></li>
                  <li><Icon name="check" /><span><b>Whoever owns the Squeek</b> at claim time gets paid.</span></li>
                  <li><Icon name="check" /><span><b>Unclaimed ETH</b> rolls back into the rewards bucket when the epoch expires.</span></li>
                </ul>
                <p className="panel__note">{p.epochs.length ? `${p.epochs.length} epoch${p.epochs.length === 1 ? "" : "s"} posted on chain so far.` : "No epoch has been posted yet."}</p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
