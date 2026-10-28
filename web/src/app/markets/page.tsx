"use client";
/**
 * /markets - the principal pool and the research list of stock-token pairs. Liquidity and fees are
 * contract reads; research rows are config only and never claim a deployment.
 */
import { useState } from "react";
import { CONFIG } from "@/lib/config";
import { HUB, PRIMARY_POOL_ID, uniswapPool } from "@/lib/chain";
import { amt } from "@/lib/format";
import { useProtocol } from "@/lib/useProtocol";
import { Icon, Kicker, SiteFooter, SiteHeader, useMotion } from "@/components/Site";
import { StockIcon } from "@/components/StockIcons";

const PAIR = CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "Nutshell";

export default function MarketsPage() {
  useMotion();
  const p = useProtocol();
  const [filter, setFilter] = useState<"ALL" | "LIVE" | "MAG7" | "CRYPTO">("ALL");
  const research = CONFIG.RESEARCH_MARKETS.filter((m) => filter === "ALL" || m.group === filter);
  const showPrimary = filter === "ALL" || filter === "LIVE";
  return (
    <>
      <SiteHeader />

      <main id="top">
        <div className="t-light">
          <section id="markets" className="wrap section">
            <header className="shead" data-reveal>
              <Kicker>Markets</Kicker>
              <h1>Big names. Onchain markets.</h1>
              <p className="lead">
                One live market first. Tokenized stock pairs are research only until each asset clears issuer and
                technical review on this network.
              </p>
            </header>
            <div className="pooltypes" data-reveal>
              <span className="mono-label">Pool types</span>
              <span className="tag">{PAIR} / ETH</span>
              <span className="tag">{PAIR} / Stock Token</span>
              <span className="tag">Stock Token / Stablecoin</span>
              <span className="tag">SQK / ETH</span>
            </div>
            <div className="markets" data-reveal>
              <div className="markets__bar">
                <div className="segmented" role="tablist" aria-label="Filter markets">
                  {(["ALL", "LIVE", "MAG7", "CRYPTO"] as const).map((f) => (
                    <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "is-on" : ""} onClick={() => setFilter(f)}>
                      {f === "ALL" ? "All" : f === "LIVE" ? "Live" : f === "MAG7" ? "MAG7" : "Crypto"}
                    </button>
                  ))}
                </div>
                <span className="tag tag--amber"><Icon name="lock" size={12} /> Stock pairs under review</span>
              </div>
              <div className="mtable">
                <div className="mtable__head" aria-hidden="true">
                  <span>Asset</span><span>Category</span><span>Status</span><span>Liquidity</span><span>Fees collected</span><span />
                </div>
                {showPrimary && (() => {
                  const live = !!(PRIMARY_POOL_ID && p.poolLive);
                  const cells = (
                    <>
                      <span className="asset">
                        <span className="logo logo--acorn" aria-hidden="true">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/acorn-mark.png" alt="" width={23} height={40} />
                        </span>
                        <span>
                          <b>{PAIR} / ETH</b>
                          <small>Principal market<span className="asset__type"> · Uniswap v4 · {CONFIG.PRIMARY_POOL.feeBps / 100}%</span></small>
                        </span>
                      </span>
                      <span data-label="Category"><span className="tag">Principal</span></span>
                      <span data-label="Status" className="status">
                        <span className={`dot ${live ? "dot--live" : "dot--amber"}`} aria-hidden="true" /> {live ? "Live" : HUB ? "Planned" : "Not deployed"}
                      </span>
                      <span data-label="Liquidity" className="mono">{p.positions === null ? "—" : `${p.positions} position${p.positions === 1 ? "" : "s"}`}</span>
                      <span data-label="Fees collected" className="mono">{p.feesEth === null ? "—" : `${amt(p.feesEth)} ETH`}</span>
                      <span className={`mtable__go${live ? "" : " mtable__go--off"}`} aria-hidden="true"><Icon name={live ? "out" : "lock"} /></span>
                    </>
                  );
                  return live ? (
                    <a className="mtable__row mtable__row--primary" href={uniswapPool(PRIMARY_POOL_ID!)} target="_blank" rel="noreferrer" aria-label="View the principal pool on Uniswap">{cells}</a>
                  ) : (
                    <div className="mtable__row mtable__row--primary">{cells}</div>
                  );
                })()}
                {filter !== "LIVE" &&
                  research.map((m) => (
                    <div className="mtable__row" key={m.ticker}>
                      <span className="asset">
                        <span className="logo" aria-hidden="true"><StockIcon symbol={m.ticker} name={m.name} /></span>
                        <span><b>{m.ticker}</b><small>{m.name}<span className="asset__type"> · Stock token</span></small></span>
                      </span>
                      <span data-label="Category"><span className="tag">{m.group === "CRYPTO" ? "Crypto" : m.group}</span></span>
                      <span data-label="Status" className="status"><span className="dot dot--amber" aria-hidden="true" /> Under review</span>
                      <span data-label="Liquidity" className="mono muted">Not deployed</span>
                      <span data-label="Fees collected" className="mono muted">—</span>
                      <span className="mtable__go mtable__go--off" aria-hidden="true"><Icon name="lock" /></span>
                    </div>
                  ))}
              </div>
            </div>
            <p className="fineprint">
              Research markets are under consideration only. No stock token is assumed to be deployed, liquid or usable on
              this network. Company names are trademarks of their owners; no affiliation or endorsement is implied.
            </p>
          </section>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}
