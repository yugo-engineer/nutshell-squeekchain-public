"use client";
/**
 * /dashboard - hub totals, buckets and the burn log. Rule from the spec: no invented TVL, APR,
 * revenue or buyback figures; every value is a contract read and anything missing renders NOT
 * AVAILABLE.
 */
import { CONFIG } from "@/lib/config";
import { HUB, explorer, short } from "@/lib/chain";
import { amt, NA } from "@/lib/format";
import { useProtocol } from "@/lib/useProtocol";
import { Kicker, SiteFooter, SiteHeader, useMotion } from "@/components/Site";

function Score({ k, v, unit, live, i, sm }: { k: string; v: string | null; unit?: string; live: boolean; i: number; sm?: boolean }) {
  return (
    <div className={`score${sm ? " score--sm" : ""}`} style={{ "--i": i } as React.CSSProperties}>
      <span className="mono-label">{k}</span>
      {v === null ? <b className="na">—</b> : <b>{v}{unit && <small>{unit}</small>}</b>}
      <span className="score__foot">
        <span className={`tag${live && v !== null ? " tag--live" : ""}`}>{live ? (v === null ? "Reading" : "Live") : "Soon"}</span>
        <span className="mono-label">onchain</span>
      </span>
    </div>
  );
}

export default function DashboardPage() {
  useMotion();
  const p = useProtocol();
  return (
    <>
      <SiteHeader />

      <main id="top">
        <section id="dashboard" className="t-light band">
          <div className="wrap">
            <header className="shead" data-reveal>
              <Kicker>Dashboard</Kicker>
              <h1>Dashboard going nuts.</h1>
              <p className="lead">
                {HUB ? `Read live from ${short(HUB)} on ${CONFIG.CHAIN_NAME}, every 20 seconds.` : `No hub on ${CONFIG.CHAIN_NAME} yet.`} Position
                value and TVL need a pool price and stay hidden until they can be shown honestly.
              </p>
            </header>
            <div className="scoreboard" data-reveal>
              <Score i={0} live={!!HUB} k="Fees collected · ETH" v={amt(p.feesEth)} unit="ETH" />
              <Score i={1} live={!!HUB} k="Treasury retained" v={amt(p.treasuryEth)} unit="ETH" />
              <Score i={2} live={!!HUB} k="Paid to Squeeks" v={amt(p.rewardsPaid)} unit="ETH" />
              <Score i={3} live={!!HUB} k={`${CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "Token"} burned`} v={amt(p.nutsBurned, 0)} />
            </div>
            <div className="scoreboard" data-reveal>
              <Score sm i={0} live={!!HUB} k="Free capital" v={amt(p.freeEth)} unit="ETH" />
              <Score sm i={1} live={!!HUB} k="Rewards bucket" v={amt(p.rewardsEth)} unit="ETH" />
              <Score sm i={2} live={!!HUB} k="Reserved for epochs" v={amt(p.epochReserved)} unit="ETH" />
              <Score sm i={3} live={!!HUB} k={`Fees collected · ${CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "token"}`} v={amt(p.feesNuts, 0)} />
            </div>

            <div className="subhead">
              <h3>Bought. Burned.</h3>
              <span className="mono-label">Burn log · {CONFIG.CHAIN_NAME}</span>
            </div>
            <div className="table-wrap">
              {p.burns.length ? (
                <table className="table">
                  <thead>
                    <tr><th>Block</th><th className="num">Burned</th><th className="num">Supply after</th><th>Transaction</th></tr>
                  </thead>
                  <tbody>
                    {p.burns.map((b) => (
                      <tr key={b.tx + b.amount}>
                        <td>{b.block.toString()}</td>
                        <td className="num">{amt(b.amount, 2)}</td>
                        <td className="num">{amt(b.supplyAfter, 0)}</td>
                        <td><a href={explorer("tx", b.tx)} target="_blank" rel="noreferrer">{short(b.tx)}</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty">{HUB ? "No burns yet" : "Not available - hub not deployed"}</div>
              )}
            </div>
            <p className="fineprint">
              Not a fake dashboard. Every value is contract state; anything the chain can&apos;t answer shows as {NA}.
              {p.error && <> Read error: {p.error}</>}
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
