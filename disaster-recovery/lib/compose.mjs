// Runs `docker compose` or `podman compose` in this folder. It uses Docker, or Podman when there's
// no Docker. Set CONTAINER_CLI=podman (or docker) to pick one.

import { spawn, spawnSync } from "node:child_process";

export const root = new URL("../", import.meta.url);

let cli;
export function containerCli() {
  if (cli !== undefined) return cli;
  const has = (name) => spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
  cli = process.env.CONTAINER_CLI ?? (has("docker") ? "docker" : has("podman") ? "podman" : null);
  return cli;
}

/**
 * Runs `<cli> compose <args>` in this folder, and resolves with { code, output }.
 * @param {string[]} args
 */
export function compose(args) {
  const name = containerCli();
  if (!name) return Promise.resolve({ code: 127, output: "Neither docker nor podman is on your PATH." });
  return new Promise((resolve) => {
    const child = spawn(name, ["compose", ...args], {
      cwd: root,
      // `podman compose` runs podman-compose, and this keeps it from printing a banner each time.
      env: { ...process.env, PODMAN_COMPOSE_WARNING_LOGS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: 127, output: error.message }));
    child.on("close", (code) => resolve({ code, output: withoutBanner(output) }));
  });
}

/**
 * Runs a command in a running service's container, and resolves with { code, output }.
 * @param {string} service production or restore
 * @param {string[]} command
 * @param {{ user?: string }} [options]
 */
export function exec(service, command, { user } = {}) {
  return compose(["exec", "-T", ...(user ? ["-u", user] : []), service, ...command]);
}

// Older versions of podman-compose print this banner whatever the variable says. And when a
// command fails, `podman compose` adds a line that repeats the whole podman-compose command.
function withoutBanner(output) {
  return output
    .split("\n")
    .filter((line) => !line.includes("Executing external compose provider"))
    .filter((line) => !/^Error: executing \S*podman-compose\b/.test(line))
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
}
