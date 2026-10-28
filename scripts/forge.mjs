/**
 * Runs Foundry inside Docker, so there is nothing to install on the host.
 *
 *   npm test              # unit suite
 *   npm run test:fork     # the Sepolia fork suite (needs network from the container)
 *   npm run test:gas      # unit suite with a gas report
 *
 * Same runner as nftlaunchpad2. First run pulls ghcr.io/foundry-rs/foundry (~500MB).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "ghcr.io/foundry-rs/foundry:latest";

// Single-quote every argument: match patterns are regexes and contain characters the
// container shell would otherwise interpret.
const quote = (a) => (/^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const cmd = ["forge", ...process.argv.slice(2).map(quote)].join(" ");

const res = spawnSync(
  "docker",
  ["run", "--rm", "-v", `${ROOT}:/src`, "-w", "/src", "--entrypoint", "sh", IMAGE, "-c", cmd],
  { stdio: "inherit" }
);

if (res.error) {
  console.error(`\nCould not run Docker: ${res.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = res.status ?? 1;
}
