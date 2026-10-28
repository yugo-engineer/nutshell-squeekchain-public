"use client";
/**
 * /admin - the operator's console. Not linked from the site, and shown only to a wallet that is
 * owner or operator of the hub or the presale. That gate is cosmetic: every number here is a
 * public chain read, and the contracts - not this page - decide who may send what.
 *
 * Reads: lib/admin.ts. Writes: lib/admin-actions.ts, all through one dialog that simulates
 * first, so a revert shows its reason before the wallet ever opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, formatEther, formatUnits, type Hex } from "viem";
import { CONFIG } from "@/lib/config";
import { ETH, HUB, NUTS, chain, explorer, publicClient, short } from "@/lib/chain";
import { amt, NA } from "@/lib/format";
import { NUTSHELL_ABI } from "@/lib/nutshell-abi";
import { PRESALE_ABI } from "@/lib/presale-abi";
import { SALE, loadAdmin, pairLabel, sym, type Admin } from "@/lib/admin";
import { ACTIONS, actionById, buildArgs, cfgKeyOptions, isOwnerKey, type Action } from "@/lib/admin-actions";

const TABS = ["overview", "pools", "treasury", "config", "epochs", "presale", "roles"] as const;
type Tab = (typeof TABS)[number];
type Open = { id: string; prefill?: Record<string, string>; choices?: string[] } | null;

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const isZero = (a?: string | null) => !a || BigInt(a) === 0n;
const when = (t: number) => (t ? new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const dur = (s: bigint) => {
  const n = Number(s);
  return n >= 86_400 ? `${+(n / 86_400).toFixed(1)} d` : n >= 3600 ? `${+(n / 3600).toFixed(1)} h` : `${Math.round(n / 60)} min`;
};
const cfgText = (k: string, v: bigint | null) =>
  v === null ? NA : k.endsWith("Bps") ? `${Number(v) / 100}%` : k === "paused" ? (v ? "yes" : "no") : `${dur(v)}`;
const tok = (v: bigint | null, t: string) => (v === null ? NA : `${amt(v)} ${sym(t)}`);
/** Raw v4 liquidity is a huge integer; 4.00e19 reads better than twenty digits. */
const liq = (v: bigint | null) => (v === null ? NA : v < 1_000_000n ? v.toLocaleString() : Number(v).toExponential(2));
const big = (v: bigint | null) => (v === null ? NA : Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 0 }));

function Addr({ a }: { a: string | null }) {
  if (!a || isZero(a)) return <span className="muted">none</span>;
  return <a href={explorer("address", a)} target="_blank" rel="noreferrer"><code>{short(a)}</code></a>;
}
function Tag({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return <span className={`tag ${ok === null ? "" : ok ? "tag--ok" : "tag--bad"}`}>{children}</span>;
}

export default function AdminPage() {
  const [me, setMe] = useState<Hex | null>(null);
  const [data, setData] = useState<Admin | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [open, setOpen] = useState<Open>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Wallet: pick up an already-connected account without a prompt, follow account switches.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    eth.request({ method: "eth_accounts" }).then((a) => setMe(((a as Hex[])[0] ?? null) as Hex | null)).catch(() => {});
    const on = (eth as unknown as { on?: (e: string, f: (a: Hex[]) => void) => void }).on;
    on?.call(eth, "accountsChanged", (a: Hex[]) => setMe(a[0] ?? null));
  }, []);
  const connect = async () => {
    try {
      const [a] = (await window.ethereum!.request({ method: "eth_requestAccounts" })) as Hex[];
      setMe(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Tab in the URL hash, so a reload or a shared link lands on the same view.
  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.includes(h)) setTab(h);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  };

  // Buyers need a log scan, so only once the presale tab has been opened.
  const wantBuyers = useRef(false);
  if (tab === "presale") wantBuyers.current = true;
  useEffect(() => {
    let alive = true;
    loadAdmin(wantBuyers.current)
      .then((d) => alive && (setData(d), setErr(null)))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    const t = setInterval(() => loadAdmin(wantBuyers.current).then((d) => alive && setData(d)).catch(() => {}), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nonce, tab === "presale"]); // eslint-disable-line react-hooks/exhaustive-deps

  const roles = useMemo(() => {
    if (!me || !data) return null;
    const s = data.sale;
    return {
      hubOwner: same(me, data.owner),
      hubOperator: same(me, data.owner) || same(me, data.operator),
      hubPending: same(me, data.pendingOwner),
      saleOwner: !!s && same(me, s.owner),
      saleOperator: !!s && (same(me, s.owner) || same(me, s.operator)),
      salePending: !!s && same(me, s.pendingOwner),
    };
  }, [me, data]);
  const can = (a: Action) => {
    if (!roles) return false;
    if (a.who === "anyone") return true;
    const hub = a.c === "hub";
    if (a.who === "owner") return hub ? roles.hubOwner : roles.saleOwner;
    if (a.who === "pending") return hub ? roles.hubPending : roles.salePending;
    return hub ? roles.hubOperator : roles.saleOperator;
  };
  const allowed = !!roles && Object.values(roles).some(Boolean);

  return (
    <div className="t-light adm">
      <header className="adm__top">
        <div className="wrap adm__bar">
          <a className="adm__brand" href="/">Nutshell <span className="muted">/ admin</span></a>
          <span className="tag">{CONFIG.CHAIN_NAME}</span>
          <span className="adm__spacer" />
          {data && <span className="mono-label">Updated {new Date(data.at).toLocaleTimeString("en-GB")}</span>}
          {allowed && <button className="btn btn--ghost btn--xs" onClick={refresh}>Refresh</button>}
          {allowed && <button className="btn btn--ink btn--xs" onClick={() => setOpen({ id: "" })}>Actions</button>}
          {me ? <span className="tag"><span className={`dot ${allowed ? "dot--live" : ""}`} />{short(me)}</span> : null}
        </div>
      </header>

      <main className="wrap adm__main">
        {!me ? (
          <Gate title="Connect wallet" body="This page is for the hub and presale owner and operator.">
            <button className="btn btn--ink btn--sm" onClick={connect}>Connect wallet</button>
          </Gate>
        ) : !data ? (
          <Gate title={err ? "Could not load" : "Loading…"} body={err ?? "Reading the hub, the pools and the presale."}>
            {err && <button className="btn btn--ghost btn--sm" onClick={refresh}>Retry</button>}
          </Gate>
        ) : !allowed ? (
          <Gate title="Not authorised" body={`${short(me)} is not the owner or operator of the hub or the presale. Switch account in your wallet.`} />
        ) : (
          <>
            <nav className="segmented adm__tabs" aria-label="Admin sections">
              {TABS.map((t) => (
                <button key={t} className={tab === t ? "is-on" : ""} aria-pressed={tab === t} onClick={() => go(t)}>
                  {t}
                  {issues(data, t) > 0 && <i className="adm__dot" aria-label="needs attention" />}
                </button>
              ))}
            </nav>
            {err && <p className="notice notice--warn">{err}</p>}
            {tab === "overview" && <Overview d={data} go={go} act={setOpen} />}
            {tab === "pools" && <Pools d={data} act={setOpen} can={can} />}
            {tab === "treasury" && <Treasury d={data} act={setOpen} can={can} />}
            {tab === "config" && <Config d={data} act={setOpen} owner={!!roles?.hubOwner} can={can} />}
            {tab === "epochs" && <Epochs d={data} act={setOpen} can={can} />}
            {tab === "presale" && <Presale d={data} act={setOpen} can={can} />}
            {tab === "roles" && <Roles d={data} act={setOpen} can={can} />}
          </>
        )}
      </main>

      {open && data && me && (
        <ActionDialog open={open} d={data} me={me} can={can} onClose={() => setOpen(null)} onDone={refresh} />
      )}
    </div>
  );
}

function Gate({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="panel adm__gate">
      <h3>{title}</h3>
      <p className="panel__body">{body}</p>
      {children && <div>{children}</div>}
    </div>
  );
}

// =================================================================== what needs attention
type Alert = { tab: Tab; text: string; action?: Open };

function alerts(d: Admin): Alert[] {
  const out: Alert[] = [];
  const drift = d.cfg.filter((c) => c.chain !== c.want);
  if (drift.length) out.push({ tab: "config", text: `Config drift: ${drift.map((c) => c.key).join(", ")}` });
  if (d.cfg.find((c) => c.key === "paused")?.chain) out.push({ tab: "config", text: "Hub is paused: no opens, increases, swaps or new epochs" });
  for (const p of d.pools) if (p.want !== null && p.allowed !== p.want) out.push({ tab: "pools", text: `${p.id}: allowlist is ${p.allowed ? "on" : "off"}, config wants ${p.want ? "on" : "off"}` });
  for (const p of d.positions) if (p.live && p.inRange === false) out.push({ tab: "pools", text: `Position #${p.tokenId} is out of range and earns nothing` });
  for (const a of d.addrs) {
    if (a.label === "operator") continue;
    if (isZero(a.value)) out.push({ tab: "roles", text: `cfg ${a.label} is not set` });
    else if (a.want && !same(a.value, a.want)) out.push({ tab: "roles", text: `cfg ${a.label} differs from config` });
    else if (a.hasCode === false) out.push({ tab: "roles", text: `cfg ${a.label} has no code` });
  }
  if (!isZero(d.pendingOwner)) out.push({ tab: "roles", text: `Hub ownership transfer pending to ${short(d.pendingOwner)}` });
  const now = Date.now() / 1000;
  for (const e of d.epochs) if (!e.closed && now >= e.expiresAt) out.push({ tab: "epochs", text: `Epoch ${e.id} expired; close it to roll the rest back`, action: { id: "closeEpoch", prefill: { epochId: String(e.id) } } });
  const s = d.sale;
  if (s) {
    if (s.start === 0 && !s.termsMatch) out.push({ tab: "presale", text: "Presale terms differ from config", action: { id: "configure" } });
    if (s.start === 0 && s.rate === 0n) out.push({ tab: "presale", text: "Presale ETH/USD rate not set", action: { id: "rate" } });
    if (s.start === 0 && /^0x0+$/.test(s.root)) out.push({ tab: "presale", text: "Presale whitelist root not set", action: { id: "root" } });
    if (!same(s.treasury, HUB)) out.push({ tab: "roles", text: "Presale treasury is not the hub" });
    if (s.phase === 3 && !s.claimsOpen && s.totalOwed > 0n) out.push({ tab: "presale", text: "Sale ended: fund it and open TGE claims", action: { id: "openClaims", prefill: { token: NUTS ?? "" } } });
  }
  return out;
}
const issues = (d: Admin, t: Tab) => (t === "overview" ? 0 : alerts(d).filter((a) => a.tab === t).length);

// =================================================================== tabs
type P = { d: Admin; act: (o: Open) => void; can: (a: Action) => boolean };

function Btn({ id, label, prefill, act, can, kind = "ghost" }: { id: string; label?: string; prefill?: Record<string, string>; act: (o: Open) => void; can: (a: Action) => boolean; kind?: "ghost" | "ink" }) {
  const a = actionById(id);
  if (!can(a)) return null;
  return <button className={`btn btn--${kind} btn--xs`} onClick={() => act({ id, prefill })}>{label ?? a.label}</button>;
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="adm__head">
      <h3>{title}</h3>
      <div className="adm__btns">{children}</div>
    </div>
  );
}

function Overview({ d, go, act }: { d: Admin; go: (t: Tab) => void; act: (o: Open) => void }) {
  const cfg = (k: string) => d.cfg.find((c) => c.key === k)?.chain ?? null;
  const rb = cfg("rewardsBps"), bb = cfg("buybackBps");
  const eth = d.buckets.find((b) => b.token === ETH);
  const live = d.positions.filter((p) => p.live);
  const unc = live.reduce((s, p) => s + (p.key.currency0 === ETH ? p.fees0 ?? 0n : 0n), 0n);
  const s = d.sale;
  const list = alerts(d);
  const tiles: [string, string, string?][] = [
    ["Hub", cfg("paused") ? "Paused" : "Active"],
    ["Split", rb === null || bb === null ? NA : `${100 - Number(rb + bb) / 100}·${Number(rb) / 100}·${Number(bb) / 100}`, "treasury · rewards · buyback"],
    ["Live positions", String(live.length), `${amt(unc)} ETH uncollected`],
    ["Free ETH", amt(eth?.free) ?? NA, `balance ${amt(eth?.balance) ?? NA}`],
    ["Rewards ETH", amt(eth?.rewards) ?? NA, `${amt(d.epochReserved) ?? NA} reserved in epochs`],
    ["Presale", !s ? "None" : ["Not started", "Phase 1", "Phase 2", "Ended"][s.phase], s ? `${Number(formatEther(s.raised)).toFixed(3)} ETH raised` : undefined],
  ];
  return (
    <>
      <div className="adm__tiles">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="adm__tile">
            <div className="stat__k">{k}</div>
            <div className="adm__big">{v}</div>
            {sub && <div className="cell__s">{sub}</div>}
          </div>
        ))}
      </div>
      <Head title="Needs attention" />
      {list.length === 0 ? (
        <p className="notice notice--ok">All clear: chain matches config, nothing waiting.</p>
      ) : (
        <ul className="adm__alerts">
          {list.map((a, i) => (
            <li key={i}>
              <span>{a.text}</span>
              <span className="adm__btns">
                {a.action && <button className="btn btn--ink btn--xs" onClick={() => act(a.action!)}>{actionById(a.action.id).label}</button>}
                <button className="btn btn--ghost btn--xs" onClick={() => go(a.tab)}>View</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Pools({ d, act, can }: P) {
  const drift = d.pools.filter((p) => p.want !== null && p.allowed !== p.want);
  const live = d.positions.filter((p) => p.live);
  return (
    <>
      <Head title="Pools">
        {drift.length === 1 && <Btn id="setPool" label="Sync allowlist" prefill={{ pool: drift[0].poolId, allowed: String(drift[0].want) }} act={act} can={can} kind="ink" />}
        <Btn id="setPool" act={act} can={can} />
      </Head>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Pool</th><th>Allowlist</th><th className="num">Price</th><th className="num">Tick</th><th className="num">Liquidity</th></tr></thead>
          <tbody>
            {d.pools.map((p) => (
              <tr key={p.poolId}>
                <td>{pairLabel(p.key)}<div className="cell__s">{p.id}</div></td>
                <td>
                  <Tag ok={p.want === null ? null : p.allowed === p.want}>{p.allowed === null ? NA : p.allowed ? "allowed" : "off"}</Tag>
                  {p.want === null && <div className="cell__s">not in config</div>}
                </td>
                <td className="num">{p.price === null ? "not initialised" : `1 ${sym(p.key.currency0)} = ${p.price.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${sym(p.key.currency1)}`}</td>
                <td className="num">{p.tick ?? "—"}</td>
                <td className="num">{liq(p.liquidity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Head title="Positions">
        {live.length > 0 && <Btn id="collect" label="Collect all" prefill={{ tokenIds: live.map((p) => p.tokenId).join(",") }} act={act} can={can} />}
        <Btn id="open" act={act} can={can} kind="ink" />
      </Head>
      {d.positions.length === 0 ? (
        <div className="table-wrap"><div className="empty">No positions yet</div></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>Pool</th><th>Range</th><th className="num">Liquidity</th><th className="num">Uncollected</th><th /></tr></thead>
            <tbody>
              {d.positions.map((p) => (
                <tr key={String(p.tokenId)} className={p.live ? "" : "adm__dim"}>
                  <td>{String(p.tokenId)}</td>
                  <td>{pairLabel(p.key)}</td>
                  <td>
                    {!p.live ? <Tag ok={null}>closed</Tag> : <Tag ok={p.inRange}>{p.inRange === null ? NA : p.inRange ? "in range" : "out of range"}</Tag>}
                    {p.live && p.tickLower !== null && <div className="cell__s">{p.tickLower} → {p.tickUpper}</div>}
                  </td>
                  <td className="num">{liq(p.liquidity)}</td>
                  <td className="num">{p.live ? <>{tok(p.fees0, p.key.currency0)}<br />{tok(p.fees1, p.key.currency1)}</> : "—"}</td>
                  <td className="num">
                    {p.live && (
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => act({ id: "collect", choices: ["collect", "increase", "decrease", "close"], prefill: { tokenIds: String(p.tokenId), tokenId: String(p.tokenId), liquidity: String(p.liquidity ?? "") } })}
                      >
                        Manage
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Treasury({ d, act, can }: P) {
  return (
    <>
      <Head title="Balances">
        <Btn id="swapBucket" act={act} can={can} />
        <Btn id="swapTreasury" act={act} can={can} />
        <Btn id="sweepRewards" label="Sweep rewards" act={act} can={can} />
        <Btn id="withdraw" label="Withdraw" act={act} can={can} />
      </Head>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Token</th><th className="num">Balance</th><th className="num">Free</th><th className="num">Rewards</th><th className="num">Buyback</th><th className="num">Fees collected</th><th className="num">Treasury kept</th></tr></thead>
          <tbody>
            {d.buckets.map((b) => (
              <tr key={b.token}>
                <td>{sym(b.token)}</td>
                {[b.balance, b.free, b.rewards, b.buyback, b.fees, b.retained].map((v, i) => <td key={i} className="num">{amt(v) ?? NA}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fineprint">Free = balance − rewards − buyback (− epoch reserve for ETH). Only free capital can be spent or withdrawn; fees and treasury kept are lifetime totals.</p>
      <Head title="Lifetime" />
      <dl className="kv adm__kv">
        <div><dt>ETH reserved in epochs</dt><dd>{tok(d.epochReserved, ETH)}</dd></div>
        <div><dt>Rewards paid</dt><dd>{tok(d.rewardsPaid, ETH)}</dd></div>
        <div><dt>NUTS burned</dt><dd>{big(d.nutsBurned)}</dd></div>
        <div><dt>NUTS supply</dt><dd>{big(d.nutsSupply)}</dd></div>
      </dl>
    </>
  );
}

function Config({ d, act, can, owner }: P & { owner: boolean }) {
  const paused = !!d.cfg.find((c) => c.key === "paused")?.chain;
  const drift = d.cfg.filter((c) => c.chain !== c.want);
  return (
    <>
      <Head title="Config">
        <Btn id="setCfg" label={paused ? "Unpause" : "Pause"} prefill={{ key: "paused", value: paused ? "0" : "1" }} act={act} can={can} />
        {drift.length === 1 && <Btn id="setCfg" label={`Push ${drift[0].key}`} prefill={{ key: drift[0].key, value: String(drift[0].want) }} act={act} can={can} kind="ink" />}
        <Btn id="setCfg" label="Set key" act={act} can={can} />
      </Head>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Key</th><th className="num">On chain</th><th className="num">server/config.ts</th><th /></tr></thead>
          <tbody>
            {d.cfg.map((c) => (
              <tr key={c.key}>
                <td>{c.key}</td>
                <td className="num">{cfgText(c.key, c.chain)}<div className="cell__s">{c.chain === null ? "" : String(c.chain)}</div></td>
                <td className="num">{cfgText(c.key, c.want)}<div className="cell__s">{String(c.want)}</div></td>
                <td className="num">
                  {c.chain === c.want ? <Tag ok>match</Tag> : <Btn id="setCfg" label="Push" prefill={{ key: c.key, value: String(c.want) }} act={act} can={can} kind="ink" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drift.length > 1 && <p className="fineprint">Several keys differ: push each here, or all at once with <code>npm run config:push</code>.</p>}
      {!owner && <p className="fineprint">Address keys (operator, nuts, adapter…) are owner-only; see Roles.</p>}
    </>
  );
}

function Epochs({ d, act, can }: P) {
  const now = Date.now() / 1000;
  return (
    <>
      <Head title="Reward epochs"><Btn id="postEpoch" act={act} can={can} kind="ink" /></Head>
      {d.epochs.length === 0 ? (
        <div className="table-wrap"><div className="empty">No epochs posted</div></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th className="num">Total</th><th className="num">Claimed</th><th>Snapshot</th><th>Claimable</th><th>Expires</th><th>Status</th><th /></tr></thead>
            <tbody>
              {[...d.epochs].reverse().map((e) => {
                const status = e.closed ? "closed" : now < e.claimableAt ? "review" : now < e.expiresAt ? "live" : "expired";
                return (
                  <tr key={e.id} className={e.closed ? "adm__dim" : ""}>
                    <td>{e.id}</td>
                    <td className="num">{amt(e.total)} ETH</td>
                    <td className="num">{amt(e.claimed)}<div className="cell__s">{e.total ? `${((Number(e.claimed) / Number(e.total)) * 100).toFixed(1)}%` : ""}</div></td>
                    <td>{String(e.snapshotBlock)}</td>
                    <td>{when(e.claimableAt)}</td>
                    <td>{when(e.expiresAt)}</td>
                    <td><Tag ok={status === "live" ? true : status === "expired" ? false : null}>{status}</Tag></td>
                    <td className="num">
                      {status === "review" && <Btn id="cancelEpoch" label="Cancel" prefill={{ epochId: String(e.id) }} act={act} can={can} />}
                      {status === "expired" && <Btn id="closeEpoch" label="Close" prefill={{ epochId: String(e.id) }} act={act} can={can} kind="ink" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Presale({ d, act, can }: P) {
  const s = d.sale;
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <Gate title="No presale" body="PRESALE_ADDRESS is empty in web/src/lib/config.ts." />;
  const left = Math.max(0, s.phaseEnd - now);
  const clock = `${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
  const rootSet = !/^0x0+$/.test(s.root);
  const nuts = (v: bigint) => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const ready = s.termsMatch && s.rate > 0n && rootSet;
  return (
    <>
      <Head title={["Not started", "Phase 1 · Squeeks", "Phase 2 · Public", "Ended"][s.phase]}>
        {s.start === 0 && <Btn id="configure" act={act} can={can} />}
        <Btn id="rate" label="Set rate" act={act} can={can} />
        {s.start === 0 && <Btn id="root" label="Set root" act={act} can={can} />}
        {s.start === 0 && <Btn id="start" act={act} can={can} kind={ready ? "ink" : "ghost"} />}
        {s.phase === 3 && !s.claimsOpen && <Btn id="openClaims" prefill={{ token: NUTS ?? "" }} act={act} can={can} kind={s.totalOwed > 0n ? "ink" : "ghost"} />}
        {s.phase === 3 && <Btn id="saleSweep" label="Sweep" prefill={{ token: s.token && !isZero(s.token) ? s.token : NUTS ?? "" }} act={act} can={can} />}
      </Head>
      {s.start === 0 && (
        <ul className="adm__checks">
          <li><Tag ok={s.termsMatch}>{s.termsMatch ? "✓" : "✗"}</Tag> Terms match server/config.ts</li>
          <li><Tag ok={s.rate > 0n}>{s.rate > 0n ? "✓" : "✗"}</Tag> ETH/USD rate set</li>
          <li><Tag ok={rootSet}>{rootSet ? "✓" : "✗"}</Tag> Squeeks whitelist root set</li>
        </ul>
      )}
      <dl className="kv adm__kv">
        {(s.phase === 1 || s.phase === 2) && <div><dt>Time left in phase</dt><dd>{clock}</dd></div>}
        {s.start > 0 && <div><dt>Started</dt><dd>{when(s.start)}</dd></div>}
        <div><dt>Sold this phase</dt><dd>{nuts(s.sold)} / {nuts(s.cap)}</dd></div>
        <div><dt>Sold P1 / P2</dt><dd>{nuts(s.p1Sold)} / {nuts(s.p2Sold)}</dd></div>
        <div><dt>Raised</dt><dd>{Number(formatEther(s.raised)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH</dd></div>
        <div><dt>ETH / USD</dt><dd>{s.rate ? `$${Number(formatUnits(s.rate, 8)).toLocaleString()}` : NA}</dd></div>
        <div><dt>Terms</dt><dd>${Number(s.terms.fdvUsd).toLocaleString()} FDV · ${Number(s.terms.minUsd)}–${Number(s.terms.maxUsd).toLocaleString()} · {dur(s.terms.p1Duration)} + {dur(s.terms.p2Duration)}</dd></div>
        <div><dt>Whitelist root</dt><dd>{rootSet ? <code>{s.root.slice(0, 10)}…{s.root.slice(-6)}</code> : "not set"}</dd></div>
        <div><dt>Owed / token held</dt><dd>{nuts(s.totalOwed)} / {s.tokenBal === null ? NA : nuts(s.tokenBal)}</dd></div>
        <div><dt>Claims</dt><dd>{s.claimsOpen ? "open" : "closed"}</dd></div>
      </dl>

      <Head title={`Buyers${s.buyers ? ` · ${s.buyers.length}` : ""}`} />
      {s.buyers === undefined ? (
        <div className="table-wrap"><div className="empty">Scanning purchases…</div></div>
      ) : s.buyers === null ? (
        <div className="table-wrap"><div className="empty">Could not scan purchase logs; try Refresh</div></div>
      ) : s.buyers.length === 0 ? (
        <div className="table-wrap"><div className="empty">No purchases yet</div></div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Wallet</th><th>Phase</th><th className="num">Paid</th><th className="num">USD</th><th className="num">NUTS</th><th>Claim</th></tr></thead>
            <tbody>
              {s.buyers.map((b) => (
                <tr key={b.address}>
                  <td><Addr a={b.address} /></td>
                  <td>{b.phases.sort().join(" + ")}</td>
                  <td className="num">{amt(b.paid)} ETH</td>
                  <td className="num">${Number(formatEther(b.usd)).toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
                  <td className="num">{nuts(b.tokens)}</td>
                  <td>{b.owed === null ? NA : b.owed === 0n ? <Tag ok>claimed</Tag> : <span className="muted">owed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Roles({ d, act, can }: P) {
  const s = d.sale;
  const rows: [string, string | null, string | null, boolean | null][] = [
    ["Hub · owner", d.owner, null, null],
    ["Hub · pending owner", d.pendingOwner, null, null],
    ...d.addrs.map((a) => [`Hub · cfg ${a.label}`, a.value, a.want, a.hasCode] as [string, string | null, string | null, boolean | null]),
    ...(s
      ? ([
          ["Presale · owner", s.owner, null, null],
          ["Presale · pending owner", s.pendingOwner, null, null],
          ["Presale · operator", s.operator, null, null],
          ["Presale · treasury", s.treasury, HUB, null],
          ["Presale · token", s.token, null, null],
        ] as [string, string | null, string | null, boolean | null][])
      : []),
  ];
  return (
    <>
      <Head title="Roles & addresses">
        <Btn id="setCfg" label="Set hub operator" prefill={{ key: "operator" }} act={act} can={(a) => can({ ...a, who: "owner" })} />
        <Btn id="hubTransfer" label="Transfer hub" act={act} can={can} />
        <Btn id="hubAccept" act={act} can={can} kind="ink" />
        <Btn id="saleOperator" label="Set presale operator" act={act} can={can} />
        <Btn id="saleTreasury" label="Set presale treasury" act={act} can={can} />
        <Btn id="saleTransfer" label="Transfer presale" act={act} can={can} />
        <Btn id="saleAccept" act={act} can={can} kind="ink" />
      </Head>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Role</th><th>Address</th><th>Check</th></tr></thead>
          <tbody>
            {rows.map(([label, v, want, code]) => (
              <tr key={label}>
                <td>{label}</td>
                <td><Addr a={v} /></td>
                <td>
                  {want ? <Tag ok={same(v, want)}>{same(v, want) ? "matches config" : `config: ${short(want)}`}</Tag> : null}{" "}
                  {code !== null && <Tag ok={code}>{code ? "code" : "no code"}</Tag>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// =================================================================== the one action dialog
type Phase = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "ok"; tx: Hex } | { kind: "err"; text: string };

function ActionDialog({ open, d, me, can, onClose, onDone }: { open: NonNullable<Open>; d: Admin; me: Hex; can: (a: Action) => boolean; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState(open.id);
  const [v, setV] = useState<Record<string, string>>(open.prefill ?? {});
  const [st, setSt] = useState<Phase>({ kind: "idle" });
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const a = id ? actionById(id) : null;
  const ctx = { pools: d.pools, tokens: d.buckets.map((b) => b.token) };
  const pick = (next: string) => {
    setId(next);
    setV(open.prefill ?? {});
    setSt({ kind: "idle" });
  };
  const choices = (open.choices ?? []).map(actionById).filter(can);

  const send = async () => {
    if (!a) return;
    try {
      const args = buildArgs(a, v, ctx);
      if (a.warn && !window.confirm(`${a.label}\n\n${a.warn}\n\nSend it?`)) return;
      const address = (a.c === "hub" ? HUB : SALE)!;
      const abi = a.c === "hub" ? NUTSHELL_ABI : PRESALE_ABI;
      setSt({ kind: "busy", text: "Simulating…" });
      const { request } = await publicClient.simulateContract({ address, abi, functionName: a.fn, args, account: me } as never);
      const eth = window.ethereum!;
      if (Number(await eth.request({ method: "eth_chainId" })) !== CONFIG.CHAIN_ID) {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CONFIG.CHAIN_ID.toString(16)}` }] });
      }
      setSt({ kind: "busy", text: "Confirm in your wallet…" });
      const wallet = createWalletClient({ account: me, chain, transport: custom(eth) });
      const hash = await wallet.writeContract(request as never);
      setSt({ kind: "busy", text: "Waiting for the block…" });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("Transaction reverted");
      setSt({ kind: "ok", tx: hash });
      onDone();
    } catch (e) {
      // viem puts the revert reason on the line after "reverted with the following reason:"
      const m = (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message.split("\n")[0] : String(e));
      setSt({ kind: "err", text: m.replace(/\s*\n\s*/g, " ").replace(/reason:$/, "no reason given.") });
    }
  };

  const busy = st.kind === "busy";
  const groups: [string, Action[]][] = [
    ["Hub", ACTIONS.filter((x) => x.c === "hub" && can(x))],
    ["Presale", ACTIONS.filter((x) => x.c === "sale" && can(x))],
  ];

  return (
    <dialog ref={ref} className="adm__dialog" onClose={onClose} onCancel={(e) => busy && e.preventDefault()}>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="adm__head adm__head--tight">
          <h3>{a ? a.label : "Actions"}</h3>
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => ref.current?.close()} disabled={busy}>Close</button>
        </div>

        {choices.length > 1 && (
          <div className="segmented">
            {choices.map((x) => (
              <button type="button" key={x.id} className={x.id === id ? "is-on" : ""} onClick={() => pick(x.id)} disabled={busy}>{x.label.split(" ")[0]}</button>
            ))}
          </div>
        )}
        {!open.id && (
          <label className="adm__field">
            <span className="stat__k">Action</span>
            <select value={id} onChange={(e) => pick(e.target.value)} disabled={busy}>
              <option value="">Choose…</option>
              {groups.map(([g, list]) => list.length > 0 && (
                <optgroup key={g} label={g}>{list.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>
              ))}
            </select>
          </label>
        )}

        {a && (
          <>
            <p className="mono-label">{a.c === "hub" ? "Nutshell" : "NutsPresale"}.{a.fn} · {a.who}</p>
            {a.id === "configure" && <p className="panel__body">Sends the PRESALE terms from server/config.ts (mirrored in web config).</p>}
            {a.fields.map((f) => (
              <label key={f.n} className="adm__field">
                <span className="stat__k">{f.n}{f.hint && <span className="muted"> · {f.hint}</span>}</span>
                <FieldInput f={f.t} value={v[f.n] ?? ""} onChange={(x) => setV({ ...v, [f.n]: x })} d={d} disabled={busy} cfgKey={v.key} />
              </label>
            ))}
            {a.warn && <p className="notice notice--warn">{a.warn}</p>}
            <button className="btn btn--ink btn--sm btn--block" disabled={busy}>{busy ? st.text : "Send"}</button>
          </>
        )}

        {st.kind === "ok" && (
          <p className="notice notice--ok">Confirmed. <a href={explorer("tx", st.tx)} target="_blank" rel="noreferrer">View transaction</a></p>
        )}
        {st.kind === "err" && <p className="notice notice--warn">{st.text}</p>}
      </form>
    </dialog>
  );
}

function FieldInput({ f, value, onChange, d, disabled, cfgKey }: { f: string; value: string; onChange: (v: string) => void; d: Admin; disabled: boolean; cfgKey?: string }) {
  const sel = (opts: [string, string][]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      <option value="">Choose…</option>
      {opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
  if (f === "pool") return sel(d.pools.map((p) => [p.poolId, `${pairLabel(p.key)} · ${p.id}`]));
  if (f === "token") return sel(d.buckets.map((b) => [b.token, sym(b.token)]));
  if (f === "bool") return sel([["true", "true"], ["false", "false"]]);
  if (f === "bucket") return sel([["0", "Rewards"], ["1", "Buyback (NUTS out is burned)"]]);
  if (f === "cfgKey") return sel(cfgKeyOptions.map((k) => [k, isOwnerKey(k) ? `${k} · owner` : k]));
  const ph = f === "addr" ? "0x…" : f === "amount" ? "0.0" : f === "usd" ? "2450" : f === "bytes32" ? "0x… (32 bytes)" : f === "ids" ? "1, 2, 3" : cfgKey === "operator" ? "0x…" : "0";
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={ph} disabled={disabled} spellCheck={false} autoComplete="off" inputMode={f === "amount" || f === "usd" ? "decimal" : undefined} />;
}

