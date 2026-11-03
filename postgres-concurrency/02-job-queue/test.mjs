// Four workers start at the same moment. There are 6 queued jobs.

import { errorLines } from "../lib/harness.mjs";

const WORKERS = ["worker-1", "worker-2", "worker-3", "worker-4"];

export default {
  file: "claim.sql",
  lesson: "https://atomicly.dev/lessons/row-locks",
  setup: `
    TRUNCATE job_runs, jobs;
    INSERT INTO jobs (id, kind, order_id, status) VALUES
      (1, 'send_receipt', 3,  'queued'),
      (2, 'send_receipt', 7,  'queued'),
      (3, 'send_receipt', 9,  'queued'),
      (4, 'send_receipt', 11, 'queued'),
      (5, 'send_receipt', 12, 'queued'),
      (6, 'send_receipt', 1,  'queued');
  `,
  sessions: WORKERS.map((worker) => ({ name: worker, params: { worker } })),

  async check({ db, sessions }) {
    const problems = errorLines(sessions);

    const { rows: runs } = await db.query(
      `SELECT job_id, count(*)::int AS runs, string_agg(worker, ', ' ORDER BY worker) AS workers
         FROM job_runs GROUP BY job_id ORDER BY job_id`,
    );
    for (const run of runs) {
      if (run.runs > 1) {
        problems.push(`Job ${run.job_id} ran ${run.runs} times, by ${run.workers}. Each job should run once.`);
      }
    }
    for (const session of sessions) {
      if (session.waitedFor.size > 0) {
        problems.push(
          `${session.name} waited for a lock held by ${[...session.waitedFor].join(" and ")}. ` +
            "A worker should take a free job, not wait for a busy one.",
        );
      }
    }
    const {
      rows: [{ done }],
    } = await db.query("SELECT count(*)::int AS done FROM jobs WHERE status = 'done'");
    if (problems.length === 0 && done !== WORKERS.length) {
      problems.push(`${done} jobs are done. Four workers should finish four different jobs.`);
    }
    return problems;
  },
};
