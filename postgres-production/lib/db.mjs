// npm run db: opens psql in the database container. It uses Docker, or Podman when there's no
// Docker. Set CONTAINER_CLI=podman (or docker) to pick one.

import { spawnSync } from "node:child_process";

const has = (cli) => spawnSync(cli, ["--version"], { stdio: "ignore" }).status === 0;
const cli = process.env.CONTAINER_CLI ?? (has("docker") ? "docker" : has("podman") ? "podman" : null);
if (!cli) {
  console.error("Neither docker nor podman is on your PATH.");
  process.exit(2);
}

const { status } = spawnSync(
  cli,
  ["compose", "exec", "postgres", "psql", "-U", "postgres", "-d", "shop", ...process.argv.slice(2)],
  { stdio: "inherit", cwd: new URL("../", import.meta.url) },
);
process.exit(status ?? 1);
