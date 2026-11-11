// Starts the compose services when production doesn't answer or the restore container isn't
// running, and waits for them.

import pg from "pg";
import { compose, containerCli, exec } from "./compose.mjs";
import { PRODUCTION_URL, sleep } from "./harness.mjs";

const dim = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${text}\x1b[0m` : text);

export async function ensureServers() {
  if (await running()) return;
  const cli = containerCli();
  if (!cli) {
    console.error(`Nothing answers at ${PRODUCTION_URL}, and neither docker nor podman is on your PATH.`);
    process.exit(2);
  }
  console.log(dim(`Starting production and the restore server with ${cli} compose...`));
  const { code, output } = await compose(["up", "-d", "--wait"]);
  // Some versions of podman-compose don't wait for the health check, so wait here too.
  const deadline = Date.now() + 60_000;
  while (code === 0 && !(await running()) && Date.now() < deadline) await sleep(500);
  if (code !== 0 || !(await running())) {
    console.error(output);
    console.error(`The servers didn't start. Try \`${cli} compose up -d --wait\` yourself.`);
    process.exit(2);
  }
}

async function running() {
  const client = new pg.Client({ connectionString: PRODUCTION_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
  return (await exec("restore", ["true"])).code === 0;
}
