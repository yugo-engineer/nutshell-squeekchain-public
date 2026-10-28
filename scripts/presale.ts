/**
 * The Genesis Presale, from the operator's side.
 *
 *   npm run presale -- configure            # push PRESALE terms + ETH/USD rate (before start)
 *   npm run presale -- whitelist [--block N] # snapshot Squeeks owners -> Merkle root -> set it
 *   npm run presale -- start                # OPEN PHASE 1 NOW (phase 2 follows automatically)
 *   npm run presale -- rate 2450             # update ETH/USD (e.g. when phase 2 opens)
 *   npm run presale -- status
 *   npm run presale -- open-claims           # after the sale: fund with the sold NUTS, open TGE claims
 *
 * The whitelist file the site reads is web/public/presale/<root>.json - redeploy the site after
 * `whitelist` so holders can fetch their proofs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, formatEther, formatUnits, keccak256, parseAbi, type Abi, type Hex } from "viem";
import { CONFIG, PRESALE } from "../server/config";
import { assertChain, explorer, getAccount, getWalletClient, publicClient } from "./chain";
import { NUTS_PRESALE_ABI } from "../server/utils/nutspresale-artifact";
import { NUTS_TOKEN_ABI } from "../server/utils/nutstoken-artifact";
import SQUEEK_NFT_ABI from "../server/abi/SqueekNFT.json";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2];
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sale = CONFIG.PRESALE_ADDRESS as Hex;
const read = (functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: sale, abi: NUTS_PRESALE_ABI as Abi, functionName, args } as never) as Promise<never>;

async function send(label: string, functionName: string, args: unknown[]) {
  const hash = await getWalletClient().writeContract({ address: sale, abi: NUTS_PRESALE_ABI as Abi, functionName, args } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label.padEnd(22)} ${explorer(`tx/${hash}`)}`);
}

// --- address Merkle tree: leaf = keccak256(bytes.concat(keccak256(abi.encode(addr)))) -------
const leafOf = (a: Hex) => keccak256(keccak256(encodeAbiParameters([{ type: "address" }], [a])));
const pair = (a: Hex, b: Hex) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
function tree(addrs: Hex[]) {
  const leaves = addrs.map((a) => ({ a, h: leafOf(a) })).sort((x, y) => (BigInt(x.h) < BigInt(y.h) ? -1 : 1));
  const layers: Hex[][] = [leaves.map((l) => l.h)];
  while (layers[layers.length - 1].length > 1) {
    const p = layers[layers.length - 1];
    const n: Hex[] = [];
    for (let i = 0; i < p.length; i += 2) n.push(i + 1 < p.length ? pair(p[i], p[i + 1]) : p[i]);
    layers.push(n);
  }
  const proofs: Record<string, Hex[]> = {};
  leaves.forEach((l, start) => {
    const proof: Hex[] = [];
    let idx = start;
    for (let k = 0; k < layers.length - 1; k++) {
      if ((idx ^ 1) < layers[k].length) proof.push(layers[k][idx ^ 1]);
      idx >>= 1;
    }
    proofs[l.a.toLowerCase()] = proof;
  });
  return { root: layers[layers.length - 1][0], proofs };
}

async function whitelist() {
  const nft = CONFIG.SQUEEK_NFT_ADDRESS as Hex;
  const blockNumber = arg("block") ? BigInt(arg("block")!) : (await publicClient.getBlockNumber()) - 12n;
  const r = (fn: string) => publicClient.readContract({ address: nft, abi: SQUEEK_NFT_ABI as Abi, functionName: fn, blockNumber }) as Promise<bigint>;
  const [np, nr] = await Promise.all([r("nextPublicTokenId"), r("nextReserveTokenId")]);
  const maxId = (np > nr ? np : nr) - 1n;
  const owners = new Set<string>();
  for (let s = 1n; s <= maxId; s += 400n) {
    const ids: bigint[] = [];
    for (let id = s; id < s + 400n && id <= maxId; id++) ids.push(id);
    const res = await publicClient.multicall({
      contracts: ids.map((id) => ({ address: nft, abi: SQUEEK_NFT_ABI as Abi, functionName: "ownerOf", args: [id] })),
      blockNumber,
      allowFailure: true,
    });
    res.forEach((x) => x.status === "success" && owners.add((x.result as string).toLowerCase()));
  }
  if (CONFIG.DEPLOY !== "mainnet") for (const a of PRESALE.TEST_WHITELIST) owners.add(a.toLowerCase());
  const addrs = [...owners] as Hex[];
  const t = tree(addrs);
  const dir = join(ROOT, "web", "public", "presale");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${t.root}.json`), JSON.stringify({ root: t.root, snapshotBlock: blockNumber.toString(), squeekNft: nft, holders: addrs.length, proofs: t.proofs }));
  console.log(`snapshot block ${blockNumber}: ${addrs.length} wallets (Squeeks holders + ${CONFIG.DEPLOY === "mainnet" ? 0 : PRESALE.TEST_WHITELIST.length} test), root ${t.root}`);
  console.log(`  wrote web/public/presale/${t.root}.json - redeploy the site so holders can fetch proofs`);
  await send("setWhitelistRoot", "setWhitelistRoot", [t.root]);
}

async function status() {
  const s = (await read("status")) as readonly [number, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const [ph, start, end, cap, sold, raised, rate] = s;
  const names = ["not started", "phase 1 (Squeeks holders)", "phase 2 (public)", "ended"];
  const fmt = (t: bigint) => (t ? new Date(Number(t) * 1000).toISOString() : "-");
  console.log(`presale ${sale}  treasury ${await read("treasury")}`);
  console.log(`  ${names[ph]}   window ${fmt(start)} -> ${fmt(end)}`);
  console.log(`  this phase: ${formatUnits(sold, 18)} / ${formatUnits(cap, 18)} NUTS`);
  console.log(`  raised ${formatEther(raised)} ETH   rate $${formatUnits(rate, 8)}/ETH   total sold ${formatUnits((await read("totalSold")) as bigint, 18)} NUTS`);
  console.log(`  whitelist ${await read("whitelistRoot")}   claims open: ${await read("claimsOpen")}`);
}

async function main() {
  await assertChain();
  if (!sale) throw new Error("PRESALE_ADDRESS is empty - run `npm run contracts:deploy`");
  getAccount();
  switch (cmd) {
    case "configure":
      await send("configure", "configure", [PRESALE.SUPPLY, PRESALE.FDV_USD, PRESALE.MIN_USD, PRESALE.MAX_USD, PRESALE.P1_CAP, PRESALE.P2_CAP, PRESALE.P1_DURATION, PRESALE.P2_DURATION]);
      await send("setEthUsd", "setEthUsd", [PRESALE.ETH_USD_E8]);
      if (CONFIG.OPERATOR_ADDRESS) await send("setOperator", "setOperator", [CONFIG.OPERATOR_ADDRESS]);
      return status();
    case "whitelist":
      return whitelist();
    case "start":
      await send("startPhase1", "startPhase1", []);
      return status();
    case "rate":
      await send("setEthUsd", "setEthUsd", [BigInt(Math.round(Number(process.argv[3]) * 1e8))]);
      return status();
    case "open-claims": {
      const owed = (await read("totalOwed")) as bigint;
      const nuts = CONFIG.NUTS_ADDRESS as Hex;
      const have = (await publicClient.readContract({ address: nuts, abi: NUTS_TOKEN_ABI as Abi, functionName: "balanceOf", args: [sale] } as never)) as bigint;
      if (have < owed) {
        const hash = await getWalletClient().writeContract({ address: nuts, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [sale, owed - have] } as never);
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`  funded ${formatUnits(owed - have, 18)} NUTS  ${explorer(`tx/${hash}`)}`);
      }
      await send("openClaims", "openClaims", [nuts]);
      return status();
    }
    case "status":
    case undefined:
      return status();
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
