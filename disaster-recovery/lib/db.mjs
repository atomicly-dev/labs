// npm run db              opens psql in production
// npm run db -- restored  opens psql in the restored server, beside production
//
// It runs psql in the container, with Docker, or Podman when there's no Docker. Set
// CONTAINER_CLI=podman (or docker) to pick one.

import { spawnSync } from "node:child_process";
import { containerCli } from "./compose.mjs";

const args = process.argv.slice(2);
const service = args[0] === "restored" ? (args.shift(), "restore") : "production";
const cli = containerCli();
if (!cli) {
  console.error("Neither docker nor podman is on your PATH.");
  process.exit(2);
}

const { status } = spawnSync(
  cli,
  ["compose", "exec", "-u", "postgres", service, "psql", "-d", "shop", ...args],
  {
    stdio: "inherit",
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PODMAN_COMPOSE_WARNING_LOGS: "false" },
  },
);
if (status !== 0 && service === "restore") {
  console.error("The restored server runs only after a restore: run `npm run restore` or `npm run lab -- 01` first.");
}
process.exit(status ?? 1);
