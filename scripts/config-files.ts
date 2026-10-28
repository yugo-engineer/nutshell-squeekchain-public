/**
 * Rewrites `KEY: "..."` and `DEPLOY_BLOCK: n` lines in server/config.ts. Used by deploy.ts and
 * gen-key.mjs so addresses are written, never hand-pasted.
 *
 * Deployed addresses live in one DEPLOYMENTS block per network, so a write is scoped to the
 * block for the network DEPLOY names - a Sepolia deploy can never overwrite the mainnet
 * addresses. Keys outside DEPLOYMENTS (OWNER_ADDRESS, ...) are rewritten wherever they occur.
 *
 * A key this cannot find is REPORTED, never skipped in silence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY } from "../server/config";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "server/config.ts";
const SCOPED = new Set(["NUTSHELL_ADDRESS", "SWAP_ADAPTER_ADDRESS", "TRADER_ADAPTER_ADDRESS", "PRESALE_ADDRESS", "NUTS_ADDRESS", "DEPLOY_BLOCK"]);

export function patchConfigs(values: Record<string, string>) {
  const path = join(ROOT, FILE);
  let src = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(values)) {
    const re = key === "DEPLOY_BLOCK" ? /(DEPLOY_BLOCK:\s*)\d+/ : new RegExp(`(\\b${key}:\\s*)"[^"]*"`);
    const to = key === "DEPLOY_BLOCK" ? `$1${value}` : `$1"${value}"`;
    const span = SCOPED.has(key) ? networkBlock(src) : { start: 0, end: src.length };
    const body = span && src.slice(span.start, span.end);
    if (!span || !body || !re.test(body)) {
      console.log(`  !! ${FILE}: no ${key} for "${DEPLOY}" to write ${value} into - update it by hand`);
      continue;
    }
    src = src.slice(0, span.start) + body.replace(re, to) + src.slice(span.end);
  }
  writeFileSync(path, src);
  patchWebMirror(values);
}

/**
 * web/src/lib/config.ts holds ONE network's public addresses (no DEPLOYMENTS block), so the
 * deployed addresses are written straight in. Only public keys are mirrored - never the key.
 */
const WEB_FILE = "web/src/lib/config.ts";
const WEB_KEYS = new Set(["NUTSHELL_ADDRESS", "NUTS_ADDRESS", "PRESALE_ADDRESS", "SWAP_ADAPTER_ADDRESS", "DEPLOY_BLOCK"]);

function patchWebMirror(values: Record<string, string>) {
  const path = join(ROOT, WEB_FILE);
  let src: string;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!new RegExp(`NETWORK = "${DEPLOY}"`).test(src)) {
    console.log(`  !! ${WEB_FILE} targets a different network than DEPLOY="${DEPLOY}" - not patched`);
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!WEB_KEYS.has(key)) continue;
    const re = key === "DEPLOY_BLOCK" ? /(DEPLOY_BLOCK:\s*)\d+/ : new RegExp(`(\\b${key}:\\s*)"[^"]*"`);
    if (!re.test(src)) {
      console.log(`  !! ${WEB_FILE}: no ${key} - update it by hand`);
      continue;
    }
    src = src.replace(re, key === "DEPLOY_BLOCK" ? `$1${value}` : `$1"${value}"`);
  }
  writeFileSync(path, src);
}

/** Span of `<network>: { ... }` inside `const DEPLOYMENTS = {`, braces counted. */
function networkBlock(src: string): { start: number; end: number } | null {
  const at = src.indexOf("const DEPLOYMENTS");
  if (at < 0) return null;
  const m = new RegExp(`\\n\\s*${DEPLOY}:\\s*\\{`).exec(src.slice(at));
  if (!m) return null;
  const open = at + m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { start: open, end: i + 1 };
  }
  return null;
}
