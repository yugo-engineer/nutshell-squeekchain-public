"use client";
/**
 * Squeeks rewards: connect -> find this wallet's Squeeks -> show what each open epoch owes them
 * -> claim. Everything is read from chain or from the published epoch data; nothing is assumed.
 *
 * Finding Squeeks: SqueekNFT has no enumeration, so the page asks ownerOf for every issued id in
 * multicall batches (~23 calls for 8,988 ids). Amounts and proofs come from
 * /epochs/<root>/ids-<n>.json, written by `npm run epoch`, located by the ROOT on chain.
 */
import { useCallback, useState } from "react";
import type { Hex } from "viem";
import { CONFIG } from "@/lib/config";
import { HUB, SQUEEK_MINING_ABI, SQUEEK_NFT_ABI, connectWallet, explorer, publicClient, short } from "@/lib/chain";
import { NUTSHELL_ABI } from "@/lib/nutshell-abi";
import type { EpochRow } from "@/lib/useProtocol";
import { amt } from "@/lib/format";

type Owned = { id: bigint; level: number; power: bigint };
type Due = { epochId: number; ids: bigint[]; amounts: bigint[]; proofs: Hex[][]; total: bigint; claimable: boolean; claimableAt: number };

const NFT = CONFIG.SQUEEK_NFT_ADDRESS as Hex;
const MINING = CONFIG.SQUEEK_MINING_ADDRESS as Hex;
const CLAIM_BATCH = 30;

export function Rewards({ epochs, onClaimed }: { epochs: EpochRow[]; onClaimed: () => void }) {
  const [address, setAddress] = useState<Hex | null>(null);
  const [owned, setOwned] = useState<Owned[] | null>(null);
  const [due, setDue] = useState<Due[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn"; text: string; tx?: string } | null>(null);

  const scan = useCallback(
    async (who: Hex) => {
      setBusy("Finding your Squeeks…");
      setMsg(null);
      setProgress(0);
      const [np, nr] = await Promise.all([
        publicClient.readContract({ address: NFT, abi: SQUEEK_NFT_ABI, functionName: "nextPublicTokenId" }),
        publicClient.readContract({ address: NFT, abi: SQUEEK_NFT_ABI, functionName: "nextReserveTokenId" }),
      ]);
      const maxId = (np > nr ? np : nr) - 1n;
      const mine: bigint[] = [];
      const step = BigInt(CONFIG.SQUEEK_SCAN_BATCH);
      for (let start = 1n; start <= maxId; start += step) {
        const ids: bigint[] = [];
        for (let id = start; id < start + step && id <= maxId; id++) ids.push(id);
        const res = await publicClient.multicall({
          contracts: ids.map((id) => ({ address: NFT, abi: SQUEEK_NFT_ABI, functionName: "ownerOf", args: [id] }) as const),
          allowFailure: true,
        });
        res.forEach((r, i) => {
          if (r.status === "success" && (r.result as string).toLowerCase() === who.toLowerCase()) mine.push(ids[i]);
        });
        setProgress(Number((start * 100n) / maxId));
      }
      setProgress(100);

      const pos = mine.length
        ? await publicClient.multicall({
            contracts: mine.map((id) => ({ address: MINING, abi: SQUEEK_MINING_ABI, functionName: "position", args: [0, id] }) as const),
            allowFailure: true,
          })
        : [];
      const list = mine.map((id, i) => {
        const p = pos[i]?.status === "success" ? (pos[i].result as { level: number; activeWeight: bigint }) : null;
        return { id, level: p ? Number(p.level) : 0, power: p ? BigInt(p.activeWeight) : 0n };
      });
      setOwned(list);

      // What each open epoch owes these Squeeks.
      const now = Date.now() / 1000;
      const out: Due[] = [];
      if (HUB) {
        for (const e of epochs.filter((x) => !x.closed && now < x.expiresAt)) {
          const buckets = new Map<bigint, Record<string, [string, Hex[]]>>();
          const d: Due = { epochId: e.id, ids: [], amounts: [], proofs: [], total: 0n, claimable: now >= e.claimableAt, claimableAt: e.claimableAt };
          for (const s of list) {
            const b = s.id / 100n;
            if (!buckets.has(b)) {
              const res = await fetch(`${CONFIG.EPOCHS_BASE}/${e.root}/ids-${b}.json`);
              buckets.set(b, res.ok ? await res.json() : {});
            }
            const entry = buckets.get(b)![s.id.toString()];
            if (!entry) continue;
            const claimed = await publicClient.readContract({ address: HUB, abi: NUTSHELL_ABI, functionName: "claimed", args: [BigInt(e.id), s.id] });
            if (claimed) continue;
            d.ids.push(s.id);
            d.amounts.push(BigInt(entry[0]));
            d.proofs.push(entry[1]);
            d.total += BigInt(entry[0]);
          }
          if (d.ids.length) out.push(d);
        }
      }
      setDue(out);
      setBusy(null);
    },
    [epochs]
  );

  const connect = async () => {
    try {
      const { address: a } = await connectWallet();
      setAddress(a);
      await scan(a);
    } catch (e) {
      setBusy(null);
      setMsg({ kind: "warn", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  };

  const claim = async (d: Due) => {
    if (!HUB) return;
    try {
      const { wallet, address: a } = await connectWallet();
      let last = "";
      for (let i = 0; i < d.ids.length; i += CLAIM_BATCH) {
        setBusy(`Claiming epoch ${d.epochId} (${Math.min(i + CLAIM_BATCH, d.ids.length)}/${d.ids.length})…`);
        const hash = await wallet.writeContract({
          account: a,
          chain: wallet.chain,
          address: HUB,
          abi: NUTSHELL_ABI,
          functionName: "claim",
          args: [BigInt(d.epochId), d.ids.slice(i, i + CLAIM_BATCH), d.amounts.slice(i, i + CLAIM_BATCH), d.proofs.slice(i, i + CLAIM_BATCH)],
        });
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status !== "success") throw new Error(`Claim reverted: ${hash}`);
        last = hash;
      }
      setMsg({ kind: "ok", text: `Claimed ${amt(d.total, 6)} ETH from epoch ${d.epochId}.`, tx: last });
      onClaimed();
      await scan(a);
    } catch (e) {
      setBusy(null);
      setMsg({ kind: "warn", text: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  };

  const totalDue = due.filter((d) => d.claimable).reduce((s, d) => s + d.total, 0n);
  const totalPower = owned?.reduce((s, o) => s + o.power, 0n) ?? 0n;

  return (
    <div className="claim">
      <div className="claim__head">
        <div>
          <div className="stat__k">Claimable now</div>
          <div className="claim__total">{address && owned ? `${amt(totalDue, 6)} ETH` : "—"}</div>
        </div>
        {address ? (
          <span className="tag tag--live">{short(address)}</span>
        ) : (
          <button className="btn btn--amber" onClick={connect} disabled={!!busy}>
            Connect wallet
          </button>
        )}
      </div>

      {!HUB && (
        <p className="notice">
          The Nutshell hub is not deployed on {CONFIG.CHAIN_NAME} yet, so no reward epochs exist. You can still connect
          to see your Squeeks and their power.
        </p>
      )}

      {busy && (
        <>
          <p className="mono muted" style={{ margin: "12px 0 0", fontSize: 12 }}>{busy}</p>
          {busy.startsWith("Finding") && (
            <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${progress}%` }} />
            </div>
          )}
        </>
      )}

      {owned && (
        <>
          <p className="mono" style={{ fontSize: 12, letterSpacing: ".08em", margin: "16px 0 0" }}>
            {owned.length} SQUEEK{owned.length === 1 ? "" : "S"} · TOTAL POWER {totalPower.toLocaleString()}
          </p>
          {owned.length ? (
            <div className="squeeks">
              {owned.map((o) => (
                <div className="sq" key={o.id.toString()}>
                  <b>#{o.id.toString()}</b>
                  <span>LV {o.level} · {o.power.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="notice">This wallet holds no Squeeks on {CONFIG.CHAIN_NAME}.</p>
          )}
        </>
      )}

      {due.map((d) => (
        <div key={d.epochId} className="kv" style={{ marginTop: 12 }}>
          <div>
            <dt>Epoch {d.epochId}</dt>
            <dd>{amt(d.total, 6)} ETH · {d.ids.length} Squeek{d.ids.length === 1 ? "" : "s"}</dd>
          </div>
          <div>
            <dt>{d.claimable ? "Ready" : "Opens"}</dt>
            <dd>
              {d.claimable ? (
                <button className="btn btn--amber btn--sm" onClick={() => claim(d)} disabled={!!busy}>
                  Claim
                </button>
              ) : (
                new Date(d.claimableAt * 1000).toLocaleString()
              )}
            </dd>
          </div>
        </div>
      ))}
      {owned && HUB && !due.length && !busy && <p className="notice" style={{ marginTop: 12 }}>Nothing to claim right now.</p>}

      {msg && (
        <p className={`notice ${msg.kind === "ok" ? "notice--ok" : "notice--warn"}`} style={{ marginTop: 12 }}>
          {msg.text} {msg.tx && <a href={explorer("tx", msg.tx)} target="_blank" rel="noreferrer">View transaction</a>}
        </p>
      )}
    </div>
  );
}
