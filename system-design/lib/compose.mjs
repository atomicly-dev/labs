// Runs `docker compose` or `podman compose` in this folder. It uses Docker, or Podman when there's
// no Docker. Set CONTAINER_CLI=podman (or docker) to pick one.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { SERVICES } from "./urls.mjs";

export const root = new URL("../", import.meta.url);

/** The project name in compose.yaml. Compose labels each container with it. */
export const PROJECT = "atomicly-labs-system-design";

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
 * @param {Record<string, string>} [vars] Variables that compose.yaml reads, such as LAB.
 */
export function compose(args, vars = {}) {
  const name = containerCli();
  if (!name) return Promise.resolve({ code: 127, output: "Neither docker nor podman is on your PATH." });
  return new Promise((resolve) => {
    const child = spawn(name, ["compose", ...args], {
      cwd: root,
      env: { ...process.env, ...vars },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: 127, output: error.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** The compose services that don't accept a TCP connection on their published port. */
export async function servicesDown() {
  const down = [];
  for (const [name, url] of Object.entries(SERVICES)) {
    const { hostname, port } = new URL(url);
    if (!(await accepts(hostname, Number(port)))) down.push(name);
  }
  return down;
}

function accepts(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
