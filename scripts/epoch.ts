/**
 * Builds a Squeeks reward epoch: snapshot power -> split ETH -> Merkle tree -> (optionally) post.
 *
 *   npm run epoch -- --amount 0.5              # build from a fresh snapshot, write epochs/*.json
 *   npm run epoch -- --amount 0.5 --block 11972000
 *   npm run epoch -- --post epochs/epoch-0-11972000.json   # postEpoch from the owner key
 *
 * WEIGHT = SqueekMining.position(0, id).activeWeight AT THE SNAPSHOT BLOCK. That is the power
 * Squeekchain itself pays SQK by, so a merge never cuts an owner's Nutshell share. A burned ID
 * reads level 0 / weight 0 and is dropped. The hub never calls SqueekMining - an upgrade of that
 * proxy can change future snapshots, never a posted root.
 *
 * IDs are sequential on SqueekNFT (public range from 1, reserve range after it), so every ID
 * below max(nextPublicTokenId, nextReserveTokenId) is read directly - no log scan, which public
 * nodes refuse at this range anyway.
 *
 * The written file IS the published data set: block, contracts, every weight, amount and proof.
 * Anyone with an archive node can rebuild the root from it. Publish it before posting.
 *
 * !! The epoch id is part of every leaf. --post refuses if hub.epochCount() moved since build.
 * !! Snapshot reads use eth_call at a block. Public nodes keep ~128 blocks of state, so build
 *    from a recent block or use an archive RPC.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther, type Abi, type Hex } from "viem";
import { CONFIG } from "../server/config";
import { assertChain, explorer, getAccount, getWalletClient, publicClient } from "./chain";
import { allocate, buildTree, leafHash, verify } from "./lib/merkle";
import { NUTSHELL_ABI } from "../server/utils/nutshell-artifact";
import SQUEEK_MINING_ABI from "../server/abi/SqueekMining.json";
import SQUEEK_NFT_ABI from "../server/abi/SqueekNFT.json";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const BATCH = 400;

type EpochFile = {
  chainId: number;
  hub: string;
  epochId: string;
  snapshotBlock: string;
  squeekNft: string;
  squeekMining: string;
  totalWeight: string;
  total: string;
  root: Hex;
  entries: { squeekId: string; owner: string | null; weight: string; amount: string; proof: Hex[] }[];
};

async function build() {
  const amount = arg("amount");
  if (!amount) throw new Error("--amount <ETH> is required");
  const total = parseEther(amount);
  const nft = CONFIG.SQUEEK_NFT_ADDRESS as Hex;
  const mining = CONFIG.SQUEEK_MINING_ADDRESS as Hex;
  if (!nft || !mining) throw new Error("SQUEEK_NFT_ADDRESS / SQUEEK_MINING_ADDRESS are empty for this network");
  const head = await publicClient.getBlockNumber();
  const blockNumber = arg("block") ? BigInt(arg("block")!) : head - 12n; // a few blocks behind the tip

  const hub = CONFIG.NUTSHELL_ADDRESS as Hex;
  const epochId = arg("epoch")
    ? BigInt(arg("epoch")!)
    : hub
      ? ((await publicClient.readContract({ address: hub, abi: NUTSHELL_ABI, functionName: "epochCount" })) as bigint)
      : 0n;

  const read = (functionName: string) =>
    publicClient.readContract({ address: nft, abi: SQUEEK_NFT_ABI as Abi, functionName, blockNumber }) as Promise<bigint>;
  const [nextPublic, nextReserve] = await Promise.all([read("nextPublicTokenId"), read("nextReserveTokenId")]);
  const maxId = (nextPublic > nextReserve ? nextPublic : nextReserve) - 1n;
  console.log(`snapshot block ${blockNumber}   epoch ${epochId}   scanning ids 1..${maxId}`);

  const weights: { squeekId: bigint; weight: bigint }[] = [];
  const owners = new Map<bigint, string | null>();
  for (let start = 1n; start <= maxId; start += BigInt(BATCH)) {
    const ids: bigint[] = [];
    for (let id = start; id < start + BigInt(BATCH) && id <= maxId; id++) ids.push(id);
    const [pos, own] = await Promise.all([
      publicClient.multicall({
        contracts: ids.map((id) => ({ address: mining, abi: SQUEEK_MINING_ABI as Abi, functionName: "position", args: [CONFIG.SQUEEK_COLLECTION, id] })),
        blockNumber,
        allowFailure: true,
      }),
      publicClient.multicall({
        contracts: ids.map((id) => ({ address: nft, abi: SQUEEK_NFT_ABI as Abi, functionName: "ownerOf", args: [id] })),
        blockNumber,
        allowFailure: true,
      }),
    ]);
    ids.forEach((id, i) => {
      const p = pos[i];
      if (p.status !== "success") throw new Error(`position(${id}) failed at block ${blockNumber}: ${p.error?.message}`);
      const w = BigInt((p.result as { activeWeight: bigint }).activeWeight);
      weights.push({ squeekId: id, weight: w });
      owners.set(id, own[i].status === "success" ? (own[i].result as string) : null);
    });
    process.stdout.write(`\r  read ${weights.length}/${maxId}`);
  }
  console.log();

  const { entries, totalWeight, allocated } = allocate(total, weights);
  const tree = buildTree(epochId, entries);
  for (const e of entries) {
    if (!verify(tree.proofs.get(e.squeekId)!, tree.root, leafHash(epochId, e.squeekId, e.amount))) {
      throw new Error(`self-check failed for squeek ${e.squeekId}`);
    }
  }

  const file: EpochFile = {
    chainId: CONFIG.EVM_CHAIN_ID,
    hub: hub || "",
    epochId: epochId.toString(),
    snapshotBlock: blockNumber.toString(),
    squeekNft: nft,
    squeekMining: mining,
    totalWeight: totalWeight.toString(),
    total: allocated.toString(),
    root: tree.root,
    entries: entries.map((e) => ({
      squeekId: e.squeekId.toString(),
      owner: owners.get(e.squeekId) ?? null,
      weight: e.weight.toString(),
      amount: e.amount.toString(),
      proof: tree.proofs.get(e.squeekId)!,
    })),
  };
  mkdirSync(join(ROOT, "epochs"), { recursive: true });
  const out = join("epochs", `epoch-${epochId}-${blockNumber}.json`);
  writeFileSync(join(ROOT, out), JSON.stringify(file, null, 2));

  // Claim data for the site: web/public/epochs/<root>/ids-<floor(id/100)>.json, each
  // { "<squeekId>": ["<amount>", [proof...]] }. Keyed by ROOT, not epoch id, so a rebuilt-but-
  // never-posted tree can never be served for the root that is actually on chain.
  const webDir = join(ROOT, "web", "public", "epochs", tree.root);
  mkdirSync(webDir, { recursive: true });
  const buckets = new Map<bigint, Record<string, [string, Hex[]]>>();
  for (const e of entries) {
    const b = e.squeekId / 100n;
    if (!buckets.has(b)) buckets.set(b, {});
    buckets.get(b)![e.squeekId.toString()] = [e.amount.toString(), tree.proofs.get(e.squeekId)!];
  }
  for (const [b, data] of buckets) writeFileSync(join(webDir, `ids-${b}.json`), JSON.stringify(data));
  console.log(`  wrote ${buckets.size} claim buckets to web/public/epochs/${tree.root}/`);

  console.log(`  squeeks with power ${entries.length}   total power ${totalWeight}`);
  console.log(`  allocated ${formatEther(allocated)} of ${formatEther(total)} ETH (rounding dust ${total - allocated} wei stays in the bucket)`);
  console.log(`  root ${tree.root}`);
  console.log(`  wrote ${out}`);
}

async function post(path: string) {
  const f = JSON.parse(readFileSync(join(ROOT, path), "utf8")) as EpochFile;
  const hub = CONFIG.NUTSHELL_ADDRESS as Hex;
  if (!hub) throw new Error("NUTSHELL_ADDRESS is empty");
  if (f.chainId !== CONFIG.EVM_CHAIN_ID) throw new Error(`file is for chain ${f.chainId}`);
  const r = (functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: hub, abi: NUTSHELL_ABI, functionName, args } as never) as Promise<never>;
  const [count, rewards] = (await Promise.all([r("epochCount"), r("rewardsBal", ["0x0000000000000000000000000000000000000000"])])) as bigint[];
  if (count !== BigInt(f.epochId)) throw new Error(`hub is at epoch ${count}, file was built for ${f.epochId} - rebuild`);
  if (BigInt(f.total) > rewards) throw new Error(`rewards bucket holds ${formatEther(rewards)} ETH, epoch needs ${formatEther(BigInt(f.total))}`);

  getAccount();
  const hash = await getWalletClient().writeContract({
    address: hub, abi: NUTSHELL_ABI, functionName: "postEpoch", args: [f.root, BigInt(f.total), BigInt(f.snapshotBlock)],
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`postEpoch reverted: ${hash}`);
  console.log(`posted epoch ${f.epochId}: ${formatEther(BigInt(f.total))} ETH to ${f.entries.length} Squeeks  ${explorer(`tx/${hash}`)}`);
}

async function main() {
  await assertChain();
  const p = arg("post");
  if (p) await post(p);
  else await build();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
