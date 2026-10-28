"use client";
/**
 * /presale - the Genesis presale on its own page: live phase, clock, buy form and claim (all in
 * `Presale`), with the sale terms beside it. Progress is time-based, never amount raised.
 */
import { Icon, Kicker, SiteFooter, SiteHeader, useMotion } from "@/components/Site";
import { Presale } from "@/components/Presale";

export default function PresalePage() {
  useMotion();

  return (
    <>
      <SiteHeader />

      <main id="top">
        <section id="presale" className="t-light band">
          <div className="wrap">
            <header className="shead" data-reveal>
              <Kicker>Genesis presale</Kicker>
              <h1>Two hours. Two phases.</h1>
              <p className="lead">
                Phase 1 is for Squeeks holders: one hour, or until 10% of the supply sells. Phase 2 opens to everyone the
                moment phase 1 ends, for the next hour. Every payment goes straight to the treasury.
              </p>
            </header>
            <div className="tokenomics">
              <Presale />
              <article className="panel" data-reveal>
                <p className="mono-label">Terms</p>
                <ul className="checks">
                  <li><Icon name="check" /><span><b>Phase 1 · Squeeks holders.</b> One hour or 10% of supply, whichever comes first.</span></li>
                  <li><Icon name="check" /><span><b>Phase 2 · Everyone.</b> The next hour, or until 8.57% plus phase 1&apos;s unsold amount sells.</span></li>
                  <li><Icon name="check" /><span><b>$500 to $3,500 per wallet,</b> paid in ETH at the posted rate.</span></li>
                  <li><Icon name="check" /><span><b>100% claimable at TGE.</b> No vesting on presale tokens.</span></li>
                  <li><Icon name="check" /><span><b>No soft cap, no refunds.</b> Nutshell launches whether or not the presale fills.</span></li>
                </ul>
                <p className="panel__note">The progress bar tracks time through each window, never the amount raised.</p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
