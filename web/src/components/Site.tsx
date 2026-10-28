"use client";
/**
 * The chrome every page shares: announce strip, sticky top bar, footer, the small line icons and
 * the scroll motion. Links are root-relative ("/#model", "/rewards") so they work from every page.
 */
import { useEffect, useState } from "react";
import { CONFIG } from "@/lib/config";
import { HUB, NUTS, explorer, short } from "@/lib/chain";

const ICONS = {
  arrow: "M5 12h14M13 6l6 6-6 6",
  out: "M7 17 17 7M8 7h9v9",
  up: "M12 19V5M6 11l6-6 6 6",
  menu: "M4 8h16M4 16h16",
  close: "M6 6l12 12M18 6 6 18",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z",
  check: "M5 12.5l4.5 4.5L19 7",
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="wordmark__mark" src="/acorn-mark.png" alt="" width={23} height={40} />
      <span>
        nutshell<small>liquidity</small>
      </span>
    </span>
  );
}

/** `[ 01 ] The model` */
export function Kicker({ n, children }: { n?: string; children: React.ReactNode }) {
  return (
    <p className="mono-label">
      {n !== undefined && <span className="bracket">[ {n} ]</span>} <span>{children}</span>
    </p>
  );
}

const NAV = [
  ["/markets", "Markets"],
  ["/presale", "Presale"],
  ["/rewards", "Rewards"],
  ["/dashboard", "Dashboard"],
  ["/docs", "Docs"],
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const network = CONFIG.CHAIN_NAME === "Ethereum" ? "on Ethereum mainnet" : `on the ${CONFIG.CHAIN_NAME} testnet`;
  return (
    <>
      <div className="announce">
        <span className="dot" aria-hidden="true" />
        <p>
          <b>Nutshell is live {network}.</b>
        </p>
        <a href="/#model">See the model</a>
      </div>
      <header className="topbar">
        <div className="wrap topbar__inner">
          <a href="/" aria-label="Nutshell home">
            <Wordmark />
          </a>
          <nav className={`nav${open ? " is-open" : ""}`} aria-label="Main">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>
                <span aria-hidden="true">[</span> {label} <span aria-hidden="true">]</span>
              </a>
            ))}
          </nav>
          <div className="topbar__actions">
            <a className="btn btn--ink btn--sm topbar__cta" href="/rewards">
              Claim rewards <Icon name="out" size={14} />
            </a>
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon topbar__menu"
              aria-label="Menu"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <Icon name={open ? "close" : "menu"} />
            </button>
          </div>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  const link = (a: string) => (
    <a href={explorer("address", a)} target="_blank" rel="noreferrer">
      {short(a)}
    </a>
  );
  return (
    <footer className="footer t-dark">
      <div className="wrap footer__inner">
        <div>
          <Wordmark />
          <p className="muted">Liquidity, in a nutshell.</p>
        </div>
        <nav aria-label="Footer">
          {NAV.map(([href, label]) => (
            <a key={href} href={href}>{label}</a>
          ))}
          <a href="https://docs.squeekchain.com" target="_blank" rel="noreferrer">
            Squeekchain <Icon name="out" size={12} />
          </a>
          <a href="https://sepolia.squeekchain.com" target="_blank" rel="noreferrer">
            Watch the wheel <Icon name="out" size={12} />
          </a>
        </nav>
      </div>
      <div className="wrap footer__contracts">
        <span>{CONFIG.CHAIN_NAME}</span>
        <span>Hub {HUB ? link(HUB) : "not deployed"}</span>
        <span>Token {NUTS ? link(NUTS) : "not deployed"}</span>
        <span>Squeeks {link(CONFIG.SQUEEK_NFT_ADDRESS)}</span>
      </div>
      <p className="wrap footer__legal">
        Built in the Squeekchain ecosystem. Testnet software, unaudited. Nothing here is investment advice, a public
        offer or a promise of returns. Liquidity positions carry market risk, and fees earned can be offset by losses.
        No official endorsement from Squeekchain or its founder is claimed.
      </p>
    </footer>
  );
}

/**
 * Scroll motion, the nutshell-fi way: `html.motion` switches the reveal CSS on (so nothing is
 * hidden without JS or with reduced motion), [data-reveal] gets .is-in when it scrolls in, and
 * [data-progress] sections get --p (0..1) as they scroll past.
 */
export function useMotion() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    root.classList.add("motion");
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -12% 0px" }
    );
    const watch = () => document.querySelectorAll("[data-reveal]:not(.is-in)").forEach((el) => io.observe(el));
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(document.body, { childList: true, subtree: true });

    const progress = Array.from(document.querySelectorAll<HTMLElement>("[data-progress]"));
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        for (const el of progress) {
          const r = el.getBoundingClientRect();
          const span = r.height - window.innerHeight;
          const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
          el.style.setProperty("--p", p.toFixed(3));
        }
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      root.classList.remove("motion");
    };
  }, []);
}
