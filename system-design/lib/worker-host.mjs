// Lab 04: one worker process. It runs processNextJob from your file in a loop, the way the shop's
// worker deployment does, and waits 50 ms when the queue is empty. The test starts 3 of these.
//
// node lib/worker-host.mjs <your file's URL> <email provider URL> <database URL>

import pg from "pg";
import { createEmailClient } from "./email.mjs";

const [fileHref, emailUrl, databaseUrl] = process.argv.slice(2);
const { processNextJob } = await import(fileHref);

const db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
db.on("error", () => {});
const sendEmail = createEmailClient(emailUrl);

let stopping = false;
process.on("SIGTERM", () => (stopping = true));

while (!stopping) {
  let didWork = false;
  try {
    didWork = await processNextJob({ db, sendEmail });
  } catch (error) {
    console.error(`Worker ${process.pid}: processNextJob failed: ${error.message}`);
  }
  if (!didWork) await new Promise((resolve) => setTimeout(resolve, 50));
}
await db.end();
