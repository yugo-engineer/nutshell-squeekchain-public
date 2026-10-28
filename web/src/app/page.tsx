"use client";
/**
 * The public page. Layout and styling follow the nutshell-fi site (announce, key art + title row,
 * Fig. 01 plate, the pinned "why" statement, model flows, revenue, finale). Markets, presale,
 * rewards and the dashboard each have their own page (/markets, /presale, /rewards, /dashboard).
 *
 * Rule from the spec: no invented TVL, APR, revenue or buyback figures. Every number on this page
 * is a contract read; anything missing renders as NOT AVAILABLE.
 */
import { CONFIG, TOKEN_SHORT } from "@/lib/config";
import { HUB, NUTS, explorer, short } from "@/lib/chain";
import { amt, NA } from "@/lib/format";
import { useProtocol } from "@/lib/useProtocol";
import { Icon, Kicker, SiteFooter, SiteHeader, useMotion } from "@/components/Site";
import { Field } from "@/components/Field";

function Bars({ label, items }: { label: string; items: { k: string; v: number; note: string }[] }) {
  return (
    <ul className="bars" aria-label={label} data-reveal>
      {items.map((b) => (
        <li key={b.k}>
          <div className="bars__head"><span>{b.k}</span><b>{b.v}%</b></div>
          <div className="bars__track" aria-hidden="true"><span className="bars__fill" style={{ width: `${b.v}%` }} /></div>
          <small>{b.note}</small>
        </li>
      ))}
    </ul>
  );
}

/** The acorn glyph used as a hub in the flow diagrams. */
function Acorn({ x, y, s }: { x: number; y: number; s: number }) {
  return (
    <g className="fl-acorn" transform={`translate(${x} ${y}) scale(${s})`}>
      <path className="fl-acorn__nut" d="M-0.64 -0.3C-0.76 0.5 -0.5 1.1 0 1.24C0.5 1.1 0.76 0.5 0.64 -0.3C0.3 -0.2 -0.3 -0.2 -0.64 -0.3Z" />
      <path className="fl-acorn__line" d="M0 1.22 L0 1.34" />
      <path className="fl-acorn__cap" d="M-0.8 -0.2 C-0.84 -0.78 0.84 -0.78 0.8 -0.2 Q0 -0.02 -0.8 -0.2Z" />
      <path className="fl-acorn__line" d="M0 -0.6 C0.02 -0.78 0.08 -0.9 0.2 -0.98" />
    </g>
  );
}

/** Dots travelling along a path, evenly spaced. */
function Flow({ d, n, dur, tone }: { d: string; n: number; dur: number; tone: "amber" | "blue" | "ink" | "hollow" }) {
  return (
    <g className={`fd fd--${tone}`}>
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} r={4.5}>
          <animateMotion dur={`${dur}s`} begin={`${(-dur * i) / n}s`} repeatCount="indefinite" path={d} />
        </circle>
      ))}
    </g>
  );
}

function Node({ x, y, w, h, k, v }: { x: number; y: number; w: number; h: number; k: string; v: string }) {
  return (
    <g className="fl-node">
      <rect x={x} y={y} width={w} height={h} />
      <text className="fl-label" x={x + 12} y={y + 20}>{k}</text>
      <text className="fl-value" x={x + 12} y={y + h - 13}>{v}</text>
    </g>
  );
}

export default function Home() {
  useMotion();
  const p = useProtocol();
  const status = !HUB ? "Building" : p.loading ? "Reading chain" : p.poolLive ? "Live" : "Deployed";

  // Live split from the hub's config; before it loads, the tokenomics doc's defaults.
  const sp = p.split ?? { treasury: 50, rewards: 35, buyback: 15 };

  const A = { pools: "M126 210 L170 210", up: "M232 210 C268 210 262 84 296 84", mid: "M232 210 L296 210", down: "M232 210 C268 210 262 336 296 336", loop: "M366 60 C366 6 66 6 66 178" };
  const B = { in: "M150 210 L186 210", up: "M226 210 C262 210 258 120 296 120", down: "M226 210 C262 210 258 300 296 300", loop: "M363 330 C363 392 80 392 80 242" };

  return (
    <>
      <SiteHeader />

      <main id="top">
        {/* ---------- hero ---------- */}
        <section className="hero t-light">
          <div className="keyart">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="keyart__img"
              src="/hero.webp"
              width={1916}
              height={821}
              fetchPriority="high"
              alt="Specimen plate: five acorns, from a closed shell to one cut open and filled with amber spheres, and a single sphere magnified."
            />
          </div>
          <div className="wrap hero__row">
            <h1 className="hero__title">Liquidity, in a <mark>nutshell.</mark></h1>
            <div className="hero__side">
              <p className="lead">
                Nutshell owns its liquidity on Uniswap v4 and splits every fee it collects the moment it lands: treasury,
                Squeeks owners in ETH, and a buyback that burns.
              </p>
              <div className="hero__ctas">
                <a href="#model" className="btn btn--ink">See the model <Icon name="arrow" /></a>
                <a href="/presale" className="btn btn--text">Genesis presale</a>
              </div>
            </div>
          </div>
          <div className="wrap hero__plate">
            <div className="plate">
              <Field />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="plate__art" src="/acorn.webp" width={480} height={826} alt="" />
              <span className="anno anno--tl mono-label">Fig. 01 — The machine</span>
              <span className="anno anno--tr mono-label">Live read · fees in, fees out</span>
              <dl className="specimen">
                <div><dt>Network</dt><dd>{CONFIG.CHAIN_NAME}</dd></div>
                <div><dt>Positions</dt><dd>{p.positions === null ? "—" : String(p.positions).padStart(2, "0")}</dd></div>
                <div><dt>Fees</dt><dd>{p.feesEth === null ? "—" : `${amt(p.feesEth)} ETH`}</dd></div>
                <div><dt>Status</dt><dd><span className={`pulse${p.poolLive ? " pulse--live" : ""}`} aria-hidden="true" /> {status}</dd></div>
              </dl>
            </div>
          </div>
        </section>

        {/* ---------- [00] why ---------- */}
        <section id="why" className="statement t-dark" data-progress style={{ "--n": 5 } as React.CSSProperties}>
          <div className="statement__pin wrap">
            <Kicker n="00">Why Nutshell</Kicker>
            <p className="statement__line" style={{ "--i": 0 } as React.CSSProperties}>Protocol-owned <em>liquidity,</em></p>
            <p className="statement__line" style={{ "--i": 1 } as React.CSSProperties}>fees from its <em>own positions,</em></p>
            <p className="statement__line" style={{ "--i": 2 } as React.CSSProperties}>a treasury that <em>keeps half,</em></p>
            <p className="statement__line" style={{ "--i": 3 } as React.CSSProperties}>Squeeks owners <em>paid in ETH,</em></p>
            <p className="statement__line" style={{ "--i": 4 } as React.CSSProperties}>the token <em>bought and burned.</em></p>
          </div>
        </section>

        <div className="t-light">
          {/* ---------- [01] model ---------- */}
          <section id="model" className="wrap section">
            <header className="shead" data-reveal>
              <Kicker n="01">The model</Kicker>
              <h2>Built to move markets.</h2>
              <p className="lead">
                Nutshell only earns from liquidity it owns. Fees are revenue; the liquidity itself is principal and is
                never paid out. That line is enforced in the contract, not in a spreadsheet.
              </p>
            </header>
            <div className="flows">
              <figure className="flow-panel" data-reveal>
                <figcaption>
                  <span className="mono-label">Engine A · Protocol-owned liquidity</span>
                  <span className="flow-panel__title">Every collected LP fee, split on arrival</span>
                </figcaption>
                <svg viewBox="0 0 440 400" role="img" aria-label={`LP fees flow into the hub, then split: ${sp.treasury}% treasury, ${sp.rewards}% Squeeks rewards, ${sp.buyback}% buyback and burn.`}>
                  <path className="fl-path" d={A.loop} />
                  <path className="fl-path" d={A.pools} />
                  <path className="fl-path" d={A.up} />
                  <path className="fl-path" d={A.mid} />
                  <path className="fl-path" d={A.down} />
                  <Node x={10} y={178} w={116} h={64} k="Liquidity" v="Pools" />
                  <Acorn x={200} y={200} s={30} />
                  <text className="fl-label fl-label--c" x={200} y={262}>Hub</text>
                  <Node x={296} y={58} w={134} h={60} k="Treasury" v={`${sp.treasury}%`} />
                  <Node x={296} y={182} w={134} h={60} k="Squeeks · ETH" v={`${sp.rewards}%`} />
                  <Node x={296} y={306} w={134} h={60} k="Buyback & burn" v={`${sp.buyback}%`} />
                  <text className="fl-label fl-label--c fl-label--muted" x={216} y={22}>↻ free capital back into the pools</text>
                  <Flow d={A.pools} n={3} dur={1.2} tone="hollow" />
                  <Flow d={A.up} n={5} dur={2.2} tone="amber" />
                  <Flow d={A.mid} n={3} dur={2} tone="ink" />
                  <Flow d={A.down} n={2} dur={2.2} tone="amber" />
                  <Flow d={A.loop} n={4} dur={3.4} tone="amber" />
                </svg>
              </figure>
              <figure className="flow-panel" data-reveal>
                <figcaption>
                  <span className="mono-label">Engine B · Squeeks reward epochs</span>
                  <span className="flow-panel__title">The rewards share, paid out by Squeek power</span>
                </figcaption>
                <svg viewBox="0 0 440 400" role="img" aria-label="The rewards bucket funds an epoch at a snapshot block; Squeeks owners claim it in ETH; unclaimed ETH rolls back into the bucket when the epoch expires.">
                  <path className="fl-path" d={B.in} />
                  <path className="fl-path" d={B.up} />
                  <path className="fl-path" d={B.down} />
                  <path className="fl-path" d={B.loop} />
                  <Node x={10} y={178} w={140} h={64} k="Rewards bucket" v={`${sp.rewards}%`} />
                  <circle className="fl-hub" cx={206} cy={210} r={20} />
                  <text className="fl-label fl-label--c" x={206} y={250}>Epoch</text>
                  <Node x={296} y={90} w={134} h={60} k="Squeek owners" v="ETH" />
                  <Node x={296} y={270} w={134} h={60} k="Unclaimed" v="Expires" />
                  <Acorn x={206} y={207} s={11} />
                  <text className="fl-label fl-label--c fl-label--muted" x={220} y={386}>↻ rolls back into the bucket</text>
                  <Flow d={B.in} n={3} dur={1.1} tone="hollow" />
                  <Flow d={B.up} n={4} dur={2} tone="blue" />
                  <Flow d={B.down} n={2} dur={2} tone="ink" />
                  <Flow d={B.loop} n={3} dur={3.4} tone="amber" />
                </svg>
              </figure>
            </div>
            <ol className="steps" data-reveal>
              {[
                ["Build liquidity", "Treasury capital goes into allowlisted Uniswap v4 pools, starting with the principal market."],
                ["Collect fees", "Traders use those pools. The hub collects only the fees its own positions earn, never principal."],
                ["Split on arrival", `${sp.treasury}% stays as treasury capital. The contract keeps the treasury at half or more, always.`],
                ["Pay the Squeeks", `${sp.rewards}% funds reward epochs, claimed in ETH by Squeeks owners, weighted by power.`],
                ["Burn the token", `${sp.buyback}% buys ${TOKEN_SHORT} and calls burn(). Total supply goes down on chain.`],
              ].map(([h, t], i) => (
                <li key={h} style={{ "--i": i } as React.CSSProperties}>
                  <span className="steps__num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{h}</h3>
                  <p>{t}</p>
                </li>
              ))}
            </ol>
          </section>

        </div>

        {/* ---------- [02] revenue ---------- */}
        <section id="revenue" className="t-dark band">
          <div className="wrap">
            <header className="shead" data-reveal>
              <Kicker n="02">Revenue</Kicker>
              <h2>Two ways the cheeks fill up.</h2>
              <p className="lead">
                Every fee the hub collects is split in the same transaction. The split is config inside hard bounds: the
                Squeeks share tops out at 35%, and the treasury always keeps at least half.
              </p>
            </header>
            <div className="duo">
              <article className="panel" data-reveal>
                <p className="mono-label">A · Protocol-owned liquidity</p>
                <h3>Fees from Nutshell&apos;s own positions.</h3>
                <p className="panel__body">
                  The hub receives the fees its positions earn, not every fee a pool generates. A zero-liquidity collect
                  cannot contain principal, so only fees ever reach the buckets.
                </p>
                <Bars
                  label="LP fee split, read from the hub"
                  items={[
                    { k: "Treasury", v: sp.treasury, note: "Free capital for more and larger positions" },
                    { k: "Squeeks rewards", v: sp.rewards, note: "Paid in ETH, weighted by Squeek power" },
                    { k: `${CONFIG.SHOW_TICKER ? CONFIG.NUTS_SYMBOL : "Token"} buyback & burn`, v: sp.buyback, note: "Bought from the pool, then burned" },
                  ]}
                />
                <p className="panel__note">{p.split ? "Read live from the hub's config." : "Defaults from the tokenomics doc until the hub is read."} A change applies only to fees collected after it.</p>
              </article>
              <article className="panel" data-reveal>
                <p className="mono-label">B · Buyback &amp; burn</p>
                <div className="fees">
                  <div><span className="mono-label">Burned</span>{p.nutsBurned === null ? <b className="na">{NA}</b> : <b>{amt(p.nutsBurned, 0)}</b>}</div>
                  <div><span className="mono-label">Burns</span>{HUB ? <b>{p.burns.length}</b> : <b className="na">{NA}</b>}</div>
                </div>
                <p className="panel__body">
                  The buyback share buys {TOKEN_SHORT} and calls burn(), so total supply drops on chain. A transfer to
                  0xdead is not a burn, and Nutshell never does one.
                </p>
                <dl className="lines">
                  <div><dt>Total supply now</dt><dd className="mono">{amt(p.nutsSupply, 0) ?? NA}</dd></div>
                  <div><dt>Buyback bucket</dt><dd className="mono">{p.buybackEth === null ? NA : `${amt(p.buybackEth)} ETH`}</dd></div>
                  <div><dt>Token</dt><dd className="mono">{NUTS ? <a href={explorer("address", NUTS)} target="_blank" rel="noreferrer">{short(NUTS)}</a> : NA}</dd></div>
                </dl>
                <p className="panel__note">Every burn is listed with its transaction in the dashboard below.</p>
              </article>
            </div>
          </div>
        </section>

        {/* ---------- finale ---------- */}
        <section className="finale t-dark band">
          <div className="wrap finale__inner">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="finale__art" src="/acorn.webp" width={480} height={826} loading="lazy" alt="The Nutshell acorn, cut open and filled with amber spheres" />
            <p className="mono-label"><span className="bracket">[</span> Nutshell is just getting started <span className="bracket">]</span></p>
            <h2 data-reveal>Let&apos;s go <em>nuts.</em></h2>
            <p className="lead">Build liquidity. Collect fees. Grow the treasury. Pay the Squeeks. Burn the token.</p>
            <div className="hero__ctas">
              <a href="/rewards" className="btn btn--amber btn--lg">Claim rewards <Icon name="arrow" /></a>
              <a href="#top" className="btn btn--ghost btn--lg">Back to top <Icon name="up" /></a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
