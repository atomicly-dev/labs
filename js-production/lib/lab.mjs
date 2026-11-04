// npm run lab -- 01: one lab, start to finish. It runs the lab once, and then says what to do
// next: the lesson to read when it fails, the next lab when it passes.

import { readdir } from "node:fs/promises";
import { HarnessError, runLab } from "./harness.mjs";
import { checkNode } from "./node-version.mjs";

const root = new URL("../", import.meta.url);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const dim = (text) => paint("2", text);

checkNode();

const labs = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const wanted = process.argv[2];
if (!wanted) {
  console.log("Run one lab: npm run lab -- 01 (or the full name, such as 01-order-import).");
  console.log(`The labs are: ${labs.join(", ")}.`);
  process.exit(2);
}
const matches = labs.filter((lab) => lab === wanted || lab.startsWith(wanted));
if (matches.length !== 1) {
  console.error(`There's no lab called "${wanted}". The labs are: ${labs.join(", ")}.`);
  process.exit(2);
}
const name = matches[0];

const labDir = new URL(`${name}/`, root);
const { default: lab } = await import(new URL("test.mjs", labDir).href);
let outcome;
try {
  outcome = await runLab(labDir, new URL(lab.file, labDir));
} catch (error) {
  if (error instanceof HarnessError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}

if (!outcome.ok) {
  console.log(`${red("FAIL")} ${name} ${dim(`(${lab.file})`)}`);
  for (const problem of outcome.problems) console.log(`     ${problem}`);
  console.log();
  console.log(`Edit ${name}/${lab.file}, then run this again.`);
  console.log(`The situation and a hint: ${name}/README.md`);
  if (lab.lesson) console.log(`The lesson that explains it: ${lab.lesson}`);
  process.exit(1);
}

console.log(`${green("PASS")} ${name} ${dim(`(${lab.file})`)}`);
console.log(dim("Run it a few times to check the fix holds: npm test -- " + name.slice(0, 2) + " --repeat 20"));
const next = labs[labs.indexOf(name) + 1];
console.log();
console.log(next ? `Next: npm run lab -- ${next.slice(0, 2)}  (${next})` : "That was the last lab.");
