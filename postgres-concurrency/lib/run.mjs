// npm test                       runs every lab
// npm test -- 01-lost-update     runs one lab (or `npm test -- 01`)
// npm test -- --solution         runs solution.sql in place of the file you edit
// npm test -- --repeat 20        runs each lab 20 times
//
// Exits with 0 when every lab passes, 1 when a lab fails, and 2 when the test itself can't run
// (no database, or no such lab).

import { readdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { HarnessError, runLab } from "./harness.mjs";

const root = new URL("../", import.meta.url);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const dim = (text) => paint("2", text);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    solution: { type: "boolean", default: false },
    repeat: { type: "string", default: "1" },
  },
});
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) exit(2, "--repeat takes a whole number, such as 20.");

const allLabs = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const labs = positionals.length
  ? positionals.map((name) => {
      const match = allLabs.filter((lab) => lab === name || lab.startsWith(name));
      if (match.length !== 1) {
        exit(2, `There's no lab called "${name}". The labs are: ${allLabs.join(", ")}.`);
      }
      return match[0];
    })
  : allLabs;

let failed = false;
for (const name of labs) {
  const labDir = new URL(`${name}/`, root);
  const { default: lab } = await import(new URL("test.mjs", labDir).href);
  const file = values.solution ? "solution.sql" : lab.file;
  const sqlFile = new URL(file, labDir);

  let passes = 0;
  let firstFailure = null;
  for (let run = 0; run < repeat; run++) {
    let outcome;
    try {
      outcome = await runLab(lab, sqlFile);
    } catch (error) {
      if (error instanceof HarnessError) exit(2, error.message);
      throw error;
    }
    if (outcome.ok) passes++;
    else firstFailure ??= outcome;
  }

  const label = `${name} ${dim(`(${file})`)}`;
  const runs = repeat > 1 ? ` ${passes}/${repeat} runs passed` : "";
  if (passes === repeat) {
    console.log(`${green("PASS")} ${label}${runs}`);
    continue;
  }
  failed = true;
  console.log(`${red("FAIL")} ${label}${runs}`);
  for (const problem of firstFailure.problems) console.log(`     ${problem}`);
  console.log(dim(`     Read ${name}/README.md for the situation and a hint.`));
}

process.exitCode = failed ? 1 : 0;

function exit(code, message) {
  console.error(message);
  process.exit(code);
}
