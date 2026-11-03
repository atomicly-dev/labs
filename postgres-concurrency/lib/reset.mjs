// npm run reset: drops the shop database, creates it again, and runs seed.sql in it.

import { readFile } from "node:fs/promises";
import pg from "pg";
import { DATABASE_URL } from "./harness.mjs";

const url = new URL(DATABASE_URL);
const database = url.pathname.slice(1);
url.pathname = "/postgres";

const admin = new pg.Client({ connectionString: url.href });
try {
  await admin.connect();
} catch (error) {
  console.error(`Can't connect to PostgreSQL (${error.message}).`);
  console.error("Start it with `docker compose up -d --wait`, then run `npm run reset` again.");
  process.exit(2);
}
await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
await admin.end();

const shop = new pg.Client({ connectionString: DATABASE_URL });
await shop.connect();
await shop.query(await readFile(new URL("../seed.sql", import.meta.url), "utf8"));
await shop.end();
console.log(`The ${database} database is back to the start.`);
