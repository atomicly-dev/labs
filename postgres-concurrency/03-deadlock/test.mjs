// Ana sends Ben 10.00 of store credit at the same moment that Ben sends Ana 5.00.

import { errorLines } from "../lib/harness.mjs";

export default {
  file: "transfer.sql",
  lesson: "https://atomicly.dev/lessons/psql-deadlocks",
  setup: `
    UPDATE accounts SET balance = 50.00 WHERE id IN (1, 2);
  `,
  // PostgreSQL checks for a deadlock after a session waits deadlock_timeout (1s by default).
  // A shorter wait keeps the test fast.
  sessionSettings: ["SET deadlock_timeout = '100ms'"],
  sessions: [
    { name: "transfer 1 (Ana to Ben)", params: { from_id: 1, to_id: 2, amount: 10 } },
    { name: "transfer 2 (Ben to Ana)", params: { from_id: 2, to_id: 1, amount: 5 } },
  ],

  async check({ db, sessions }) {
    const problems = errorLines(sessions);
    const { rows } = await db.query("SELECT id, balance FROM accounts WHERE id IN (1, 2) ORDER BY id");
    const [ana, ben] = rows.map((row) => row.balance);
    if (ana !== "45.00" || ben !== "55.00") {
      problems.push(
        `Ana has ${ana} and Ben has ${ben}. After both transfers, Ana should have 45.00 and Ben 55.00.`,
      );
    }
    return problems;
  },
};
