// npm run log: prints the restored server's log, from its last start.

import { restoredLog } from "./harness.mjs";

const log = await restoredLog();
console.log(log || "The restored server has no log yet: run `npm run restore` or `npm run lab -- 01` first.");
