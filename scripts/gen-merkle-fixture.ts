/**
 * Writes test/fixtures/merkle.json: a tree built by scripts/lib/merkle.ts from uneven weights,
 * so test/MerkleFixture.t.sol can prove the TypeScript tree and Nutshell._verify agree - every
 * entry claims on chain, and the sum paid equals the allocated total.
 *
 *   npm run fixture:merkle
 *
 * 7 entries on purpose: an odd count exercises the carried-up node.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther } from "viem";
import { allocate, buildTree } from "./lib/merkle";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const epochId = 0n;
// Squeek power levels from SqueekMining's collection policy: 1,000 / 3,000 / 7,000 / ...
const weights = [
  { squeekId: 1n, weight: 1_000n },
  { squeekId: 2n, weight: 3_000n },
  { squeekId: 3n, weight: 1_000n },
  { squeekId: 7n, weight: 7_000n },
  { squeekId: 42n, weight: 15_000n },
  { squeekId: 8889n, weight: 1_000n },
  { squeekId: 99n, weight: 0n }, // burned: dropped
  { squeekId: 100n, weight: 63_000n },
];
const { entries, allocated } = allocate(parseEther("1"), weights);
const tree = buildTree(epochId, entries);

const out = {
  root: tree.root,
  total: allocated.toString(),
  ids: entries.map((e) => e.squeekId.toString()),
  amounts: entries.map((e) => e.amount.toString()),
  proofs: entries.map((e) => tree.proofs.get(e.squeekId)!),
};
mkdirSync(join(ROOT, "test", "fixtures"), { recursive: true });
writeFileSync(join(ROOT, "test", "fixtures", "merkle.json"), JSON.stringify(out, null, 2));
console.log(`root ${tree.root}  ${entries.length} entries  total ${allocated}`);
