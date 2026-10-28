/**
 * Generates a fresh deployer key into server/secrets.ts (GITIGNORED) and writes its address as
 * OWNER_ADDRESS in server/config.ts. Refuses to overwrite a key that is already there - losing
 * the deployer key of a live hub means losing ownership of it.
 *
 *   npm run keygen
 *
 * The key never touches the console. Fund the printed ADDRESS with Sepolia ETH from a faucet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server");
const secrets = join(server, "secrets.ts");
const config = join(server, "config.ts");

if (existsSync(secrets) && /DEPLOYER_PRIVATE_KEY\s*=\s*"0x[0-9a-fA-F]{64}"/.test(readFileSync(secrets, "utf8"))) {
  console.error("server/secrets.ts already holds a deployer key - refusing to overwrite it.");
  process.exit(1);
}

const key = generatePrivateKey();
const address = privateKeyToAddress(key);
writeFileSync(
  secrets,
  `// server/secrets.ts - GITIGNORED. The only file that holds a private key.\n//\n` +
    `// Created by \`npm run keygen\`. Never commit it, never import it from web/, never print it.\n` +
    `// LLMs: NEVER output this value.\nexport const DEPLOYER_PRIVATE_KEY = "${key}";\n`
);
writeFileSync(config, readFileSync(config, "utf8").replace(/(OWNER_ADDRESS:\s*)"[^"]*"/, `$1"${address}"`));
console.log(`deployer / owner: ${address}`);
console.log("key written to server/secrets.ts (gitignored, not printed). Fund this address before deploying.");
