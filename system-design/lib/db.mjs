// npm run db               opens psql in the primary (labs 02 to 04)
// npm run db -- replica    in the replica
// npm run db -- postgres   in lab 01's database
//
// It runs psql in the container, with Docker, or Podman when there's no Docker. Set
// CONTAINER_CLI=podman (or docker) to pick one.

import { spawnSync } from "node:child_process";
import { containerCli } from "./compose.mjs";

const services = ["primary", "replica", "postgres"];
const args = process.argv.slice(2);
const service = services.includes(args[0]) ? args.shift() : "primary";
const cli = containerCli();
if (!cli) {
  console.error("Neither docker nor podman is on your PATH.");
  process.exit(2);
}

const { status } = spawnSync(
  cli,
  ["compose", "exec", service, "psql", "-U", "postgres", "-d", "shop", ...args],
  { stdio: "inherit", cwd: new URL("../", import.meta.url) },
);
process.exit(status ?? 1);
