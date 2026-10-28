/**
 * The reward Merkle tree, built to match Nutshell.sol exactly:
 *
 *   leaf  = keccak256(bytes.concat(keccak256(abi.encode(epochId, squeekId, amount))))
 *   node  = keccak256(sorted(a, b))            // commutative, so a proof is just siblings
 *
 * Leaves are sorted before building, and an odd node at the end of a layer is carried up
 * unchanged. Nothing here needs to agree with any other library - only with `_verify` in the
 * hub, which test/MerkleFixture.t.sol checks against a tree built by this file.
 */
import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

export type Entry = { squeekId: bigint; amount: bigint };

export function leafHash(epochId: bigint, squeekId: bigint, amount: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [epochId, squeekId, amount])
  );
  return keccak256(inner);
}

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export type Tree = { root: Hex; proofs: Map<bigint, Hex[]> };

export function buildTree(epochId: bigint, entries: Entry[]): Tree {
  if (!entries.length) throw new Error("empty tree");
  const seen = new Set<bigint>();
  for (const e of entries) {
    if (seen.has(e.squeekId)) throw new Error(`duplicate squeekId ${e.squeekId}`);
    seen.add(e.squeekId);
  }

  // Sort by hash so the tree is deterministic regardless of input order.
  const leaves = entries
    .map((e) => ({ id: e.squeekId, h: leafHash(epochId, e.squeekId, e.amount) }))
    .sort((a, b) => (BigInt(a.h) < BigInt(b.h) ? -1 : 1));

  const layers: Hex[][] = [leaves.map((l) => l.h)];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }

  const proofs = new Map<bigint, Hex[]>();
  leaves.forEach((leaf, start) => {
    const proof: Hex[] = [];
    let idx = start;
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = idx ^ 1;
      if (sib < layers[l].length) proof.push(layers[l][sib]);
      idx >>= 1;
    }
    proofs.set(leaf.id, proof);
  });
  return { root: layers[layers.length - 1][0], proofs };
}

/** Same algorithm as Nutshell._verify. */
export function verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
  return proof.reduce((h, p) => hashPair(h, p), leaf) === root;
}

/**
 * Splits `total` across weights pro rata, rounding DOWN. Returns the amounts and the sum actually
 * allocated - post that sum, not `total`, so the root never promises more than it reserves.
 * Zero-weight entries are dropped.
 */
export function allocate(total: bigint, weights: { squeekId: bigint; weight: bigint }[]) {
  const live = weights.filter((w) => w.weight > 0n);
  const W = live.reduce((s, w) => s + w.weight, 0n);
  if (W === 0n) throw new Error("total weight is zero");
  const entries = live.map((w) => ({ squeekId: w.squeekId, weight: w.weight, amount: (total * w.weight) / W }))
    .filter((e) => e.amount > 0n);
  const allocated = entries.reduce((s, e) => s + e.amount, 0n);
  return { entries, totalWeight: W, allocated };
}
