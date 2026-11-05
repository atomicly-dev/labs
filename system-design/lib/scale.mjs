// npm run scale -- 4             restarts the API as 4 instances of lab 01, with config.mjs
// npm run scale -- 4 --lab 06    the same for lab 06, with limiter.mjs
//
// It restarts every API container, so they load your latest file, and waits until nginx sends
// requests to all of them. The tests do the same before they send their load.

import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HarnessError } from "./harness.mjs";
import { startApi } from "./helpers.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { lab: { type: "string", default: "01" } },
});
const instances = Number(positionals[0] ?? 2);
if (!Number.isInteger(instances) || instances < 1 || instances > 8) {
  console.error("Give a number of instances from 1 to 8, such as: npm run scale -- 4");
  process.exit(2);
}

const files = { "01-find-the-bottleneck": "config.mjs", "06-limit-across-replicas": "limiter.mjs" };
const root = new URL("../", import.meta.url);
const labs = (await readdir(root)).filter((name) => name in files);
const lab = labs.find((name) => name === values.lab || name.startsWith(values.lab));
if (!lab) {
  console.error(`The API runs lab 01 or lab 06, so --lab takes 01 or 06.`);
  process.exit(2);
}

try {
  const noun = instances === 1 ? "instance" : "instances";
  console.log(`Starting ${instances} API ${noun} of ${lab}, with ${files[lab]}...`);
  const { health, problems } = await startApi({ lab, file: files[lab], instances });
  if (problems) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`nginx sends requests to ${instances} ${noun}: ${health.map((h) => h.instance).join(", ")}.`);
  if (lab === "01-find-the-bottleneck") {
    const total = health.reduce((sum, h) => sum + h.poolMax, 0);
    console.log(`Their pools can open up to ${total} connections (${health.map((h) => h.poolMax).join(" + ")}).`);
  }
} catch (error) {
  if (error instanceof HarnessError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
