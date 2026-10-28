"use client";
/**
 * The Genesis Presale panel. Everything is read from NutsPresale on chain.
 *
 * Progress is TIME-based, by design: the bar shows how far through each one-hour window we are,
 * never how much has been raised. Phase 2's window starts when phase 1 ends - on the clock or
 * the moment phase 1 sells out - so its segment moves with it.
 *
 * Phase 1 needs a Merkle proof that the wallet is in the Squeeks snapshot; the page fetches it
 * from /presale/<root>.json (written by `npm run presale -- whitelist`), keyed by the root the
 * contract actually holds.
 */
import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseEther, type Hex } from "viem";
import { CONFIG } from "@/lib/config";
import { connectWallet, explorer, publicClient, short } from "@/lib/chain";
import { PRESALE_ABI } from "@/lib/presale-abi";

const SALE = (CONFIG.PRESALE_ADDRESS || null) as Hex | null;
const ZERO_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";

type Sale = {
  phase: number;
  phaseStart: number;
  phaseEnd: number;
  cap: bigint;
  sold: bigint;
  raised: bigint;
  rate: bigint; // USD per ETH, 8 decimals
  start: number;
  p1Duration: number;
  p2Duration: number;
  minUsd: bigint;
  maxUsd: bigint;
  fdvUsd: bigint;
  supply: bigint;
  root: Hex;
  claimsOpen: boolean;
  totalSold: bigint;
};

type Me = { usdSpent: bigint; owed: bigint; paid: bigint; proof: Hex[] | null };

const PHASES = ["Not started", "Phase 1 · Squeeks holders", "Phase 2 · Public", "Ended"];

async function loadSale(): Promise<Sale | null> {
  if (!SALE) return null;
  const c = (functionName: string) => ({ address: SALE, abi: PRESALE_ABI, functionName }) as const;
  const res = (await publicClient.multicall({
    contracts: [c("status"), c("start"), c("p1Duration"), c("p2Duration"), c("minUsd"), c("maxUsd"), c("fdvUsd"), c("totalSupplyTokens"), c("whitelistRoot"), c("claimsOpen"), c("totalSold")] as never,
    allowFailure: false,
  })) as unknown[];
  const [st, start, p1d, p2d, minUsd, maxUsd, fdvUsd, supply, root, claimsOpen, totalSold] = res as [
    readonly [number, bigint, bigint, bigint, bigint, bigint, bigint, bigint], bigint, bigint, bigint, bigint, bigint, bigint, bigint, Hex, boolean, bigint,
  ];
  return {
    phase: Number(st[0]),
    phaseStart: Number(st[1]),
    phaseEnd: Number(st[2]),
    cap: st[3],
    sold: st[4],
    raised: st[5],
    rate: st[6],
    start: Number(start),
    p1Duration: Number(p1d),
    p2Duration: Number(p2d),
    minUsd,
    maxUsd,
    fdvUsd,
    supply,
    root,
    claimsOpen,
    totalSold,
  };
}

const fmtClock = (s: number) => {
  if (s <= 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const nuts = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString("en-US", { maximumFractionDigits: 0 });

export function Presale() {
  const [sale, setSale] = useState<Sale | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [address, setAddress] = useState<Hex | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [eth, setEth] = useState("0.25");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn"; text: string; tx?: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSale(await loadSale());
    } catch {
      /* keep the last good read */
    }
  }, []);

  useEffect(() => {
    refresh();
    const a = setInterval(refresh, 8_000);
    const b = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh]);

  const loadMe = useCallback(
    async (who: Hex, s: Sale | null) => {
      if (!SALE) return;
      const c = (functionName: string) => ({ address: SALE, abi: PRESALE_ABI, functionName, args: [who] }) as const;
      const [usdSpent, owed, paid] = (await publicClient.multicall({ contracts: [c("usdSpent"), c("owed"), c("paidWei")] as never, allowFailure: false })) as bigint[];
      let proof: Hex[] | null = null;
      if (s && s.root !== ZERO_ROOT) {
        try {
          const r = await fetch(`/presale/${s.root}.json`);
          if (r.ok) proof = ((await r.json()) as { proofs: Record<string, Hex[]> }).proofs[who.toLowerCase()] ?? null;
        } catch {
          /* no list published yet */
        }
      }
      setMe({ usdSpent, owed, paid, proof });
    },
    []
  );

  useEffect(() => {
    if (address) loadMe(address, sale);
  }, [address, sale?.root, sale?.totalSold, loadMe]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!SALE) return <div className="claim"><p className="notice">The presale contract is not deployed on {CONFIG.CHAIN_NAME} yet.</p></div>;
  if (!sale) return <div className="claim"><p className="mono muted">Reading the presale…</p></div>;

  // ---- live phase from the clock (the chain's view updates every few seconds) ----
  const scheduled = sale.start !== 0;
  const p1End = sale.phase >= 2 ? sale.phaseStart : sale.start + sale.p1Duration;
  const p2End = p1End + sale.p2Duration;
  let phase = sale.phase;
  if (scheduled && phase === 0 && now >= sale.start) phase = 1;
  if (phase === 1 && now >= p1End) phase = 2;
  if (phase === 2 && now >= p2End) phase = 3;

  const frac = (a: number, b: number) => Math.max(0, Math.min(1, (now - a) / (b - a)));
  const p1Frac = !scheduled ? 0 : phase >= 2 ? 1 : frac(sale.start, sale.start + sale.p1Duration);
  const p2Frac = phase <= 1 ? 0 : phase === 3 ? 1 : frac(p1End, p2End);
  const timeLeft = phase === 0 ? sale.start - now : phase === 1 ? p1End - now : phase === 2 ? p2End - now : 0;

  const priceUsd = Number(sale.fdvUsd) / Number(formatUnits(sale.supply, 18));
  const ethUsd = Number(formatUnits(sale.rate, 8));
  const ethNum = Number(eth) || 0;
  const usd = ethNum * ethUsd;
  const estNuts = priceUsd ? usd / priceUsd : 0;
  const spentUsd = me ? Number(formatUnits(me.usdSpent, 18)) : 0;
  const leftUsd = Math.max(0, Number(sale.maxUsd) - spentUsd);
  const canPhase1 = !!me?.proof;

  const buy = async () => {
    try {
      setMsg(null);
      const { wallet, address: a } = await connectWallet();
      setAddress(a);
      setBusy("Confirm in your wallet…");
      const hash = await wallet.writeContract({
        account: a,
        chain: wallet.chain,
        address: SALE,
        abi: PRESALE_ABI,
        functionName: "buy",
        args: [phase === 1 ? me?.proof ?? [] : []],
        value: parseEther(eth),
      });
      setBusy("Waiting for the block…");
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("Purchase reverted");
      setMsg({ kind: "ok", text: "Bought. Your NUTS are claimable at TGE.", tx: hash });
      await refresh();
      await loadMe(a, sale);
    } catch (e) {
      setMsg({ kind: "warn", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const claim = async () => {
    try {
      setMsg(null);
      const { wallet, address: a } = await connectWallet();
      setBusy("Claiming…");
      const hash = await wallet.writeContract({ account: a, chain: wallet.chain, address: SALE, abi: PRESALE_ABI, functionName: "claim", args: [] });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("Claim reverted");
      setMsg({ kind: "ok", text: "Claimed.", tx: hash });
      await loadMe(a, sale);
    } catch (e) {
      setMsg({ kind: "warn", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    try {
      const { address: a } = await connectWallet();
      setAddress(a);
    } catch (e) {
      setMsg({ kind: "warn", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  };

  return (
    <div className="claim presale" data-reveal>
      <div className="claim__head">
        <div>
          <div className="stat__k">{PHASES[phase]}</div>
          <div className="claim__total">
            {!scheduled ? "Soon" : phase === 3 ? "Closed" : fmtClock(timeLeft)}
          </div>
          <div className="cell__s">{!scheduled ? "Opens when the team starts phase 1" : phase === 0 ? "until phase 1 opens" : phase === 3 ? "launch follows" : "left in this phase"}</div>
        </div>
        {address ? <span className="tag tag--live">{short(address)}</span> : <button className="btn btn--amber" onClick={connect}>Connect wallet</button>}
      </div>

      {/* time-based progress: one segment per one-hour window */}
      <div className="phasebar" role="img" aria-label={`Phase 1 ${Math.round(p1Frac * 100)}% elapsed, phase 2 ${Math.round(p2Frac * 100)}% elapsed`}>
        <div className={`phasebar__seg${phase === 1 ? " is-live" : ""}`}>
          <i style={{ width: `${p1Frac * 100}%` }} />
          <span>P1 · SQUEEKS · 1H</span>
        </div>
        <div className={`phasebar__seg${phase === 2 ? " is-live" : ""}`}>
          <i style={{ width: `${p2Frac * 100}%` }} />
          <span>P2 · PUBLIC · 1H</span>
        </div>
      </div>

      <dl className="kv" style={{ marginTop: 16 }}>
        <div><dt>Price</dt><dd>${priceUsd.toFixed(5)} / NUTS</dd></div>
        <div><dt>FDV</dt><dd>${Number(sale.fdvUsd).toLocaleString()}</dd></div>
        <div><dt>ETH rate</dt><dd>${ethUsd.toLocaleString()}</dd></div>
        <div><dt>Per wallet</dt><dd>${Number(sale.minUsd)}–${Number(sale.maxUsd).toLocaleString()}</dd></div>
        <div><dt>Sold this phase</dt><dd>{nuts(sale.sold)} / {nuts(sale.cap)}</dd></div>
        <div><dt>Raised</dt><dd>{Number(formatEther(sale.raised)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH</dd></div>
      </dl>

      {(phase === 1 || phase === 2) && (
        <div className="buy">
          {phase === 1 && address && me && !canPhase1 && (
            <p className="notice notice--warn">This wallet is not on the Squeeks snapshot. Phase 2 opens to everyone in {fmtClock(p1End - now)}.</p>
          )}
          {phase === 1 && address && canPhase1 && <p className="notice notice--ok">Squeeks holder - you are in phase 1.</p>}
          <label className="stat__k" htmlFor="presale-eth">Pay (ETH)</label>
          <div className="buy__row">
            <input id="presale-eth" className="buy__input" inputMode="decimal" value={eth} onChange={(e) => setEth(e.target.value)} />
            <button className="btn btn--amber" onClick={buy} disabled={!!busy || (phase === 1 && !!address && !canPhase1)}>
              Buy
            </button>
          </div>
          <p className="cell__s">
            ≈ ${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} · ≈ {estNuts.toLocaleString("en-US", { maximumFractionDigits: 0 })} NUTS
            {address && me ? ` · you can still buy $${leftUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : ""}
          </p>
        </div>
      )}

      {address && me && me.owed > 0n && (
        <div className="kv" style={{ marginTop: 12 }}>
          <div><dt>Your NUTS</dt><dd>{nuts(me.owed)}</dd></div>
          <div>
            <dt>{sale.claimsOpen ? "Claim" : "Claimable"}</dt>
            <dd>{sale.claimsOpen ? <button className="btn btn--amber btn--sm" onClick={claim} disabled={!!busy}>Claim</button> : "at TGE"}</dd>
          </div>
        </div>
      )}

      {busy && <p className="mono muted" style={{ marginTop: 12, fontSize: 12 }}>{busy}</p>}
      {msg && (
        <p className={`notice ${msg.kind === "ok" ? "notice--ok" : "notice--warn"}`} style={{ marginTop: 12 }}>
          {msg.text} {msg.tx && <a href={explorer("tx", msg.tx)} target="_blank" rel="noreferrer">View transaction</a>}
        </p>
      )}
    </div>
  );
}
