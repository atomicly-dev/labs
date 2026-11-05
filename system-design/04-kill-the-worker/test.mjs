// 6 customers sign up, and the API queues a welcome-email job for each. The test starts 3 worker
// processes with your worker.mjs (see lib/worker-host.mjs), and plays the email provider: a real
// HTTP server that writes each email it delivers to the sent_emails table.
//
// During the run, the test kills 2 workers with SIGKILL, the way a deploy, a crash, or the
// out-of-memory killer does:
//
// - Chen's email: after the provider delivered it, before the worker got the answer.
// - Emeka's email: when the request reaches the provider, before it delivers anything.
//
// Then it waits until no job is queued. Each customer should get exactly 1 welcome email.

import { fork } from "node:child_process";
import { connectPool, count, sleep } from "../lib/helpers.mjs";
import { PRIMARY_URL } from "../lib/urls.mjs";

const CUSTOMERS = [
  { name: "Ann", to: "ann@example.com" },
  { name: "Bilal", to: "bilal@example.com" },
  { name: "Chen", to: "chen@example.com" },
  { name: "Dana", to: "dana@example.com" },
  { name: "Emeka", to: "emeka@example.com" },
  { name: "Femi", to: "femi@example.com" },
];
const KILL_AFTER_SEND = "chen@example.com";
const KILL_BEFORE_SEND = "emeka@example.com";
const WORKERS = 3;

export default {
  file: "worker.mjs",
  lesson: "https://atomicly.dev/lessons/idempotency",

  async run(ctx) {
    const db = await connectPool(ctx, PRIMARY_URL, "the primary", { max: 4 });
    await db.query("TRUNCATE jobs, sent_emails RESTART IDENTITY");

    const workers = new Map(); // pid -> child process
    const killed = [];
    const kill = (pid, to, when) => {
      const worker = workers.get(pid);
      if (!worker) return;
      worker.kill("SIGKILL");
      killed.push({ to, when });
    };

    // The email provider. It records each email it delivers in sent_emails, and honors
    // idempotency keys.
    const emailUrl = await ctx.serve(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const email = JSON.parse(text);
      const key = req.headers["idempotency-key"] ?? null;
      const pid = Number(req.headers["x-worker-pid"]);
      const answer = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (email.to === KILL_BEFORE_SEND && !killed.some((k) => k.to === KILL_BEFORE_SEND)) {
        kill(pid, email.to, "before");
        return setTimeout(() => res.destroy(), 100);
      }
      if (key) {
        const { rows } = await db.query("SELECT id FROM sent_emails WHERE idempotency_key = $1", [key]);
        if (rows.length) return answer({ id: Number(rows[0].id) });
      }
      const { rows } = await db.query(
        `INSERT INTO sent_emails (to_address, subject, idempotency_key) VALUES ($1, $2, $3)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id`,
        [email.to, email.subject, key],
      );
      if (email.to === KILL_AFTER_SEND && !killed.some((k) => k.to === KILL_AFTER_SEND)) {
        kill(pid, email.to, "after");
        return setTimeout(() => res.destroy(), 100);
      }
      answer({ id: Number(rows[0].id) });
    });

    for (const customer of CUSTOMERS) {
      await db.query("INSERT INTO jobs (kind, payload) VALUES ('welcome-email', $1)", [customer]);
    }

    for (let i = 0; i < WORKERS; i++) {
      const worker = fork(new URL("../lib/worker-host.mjs", import.meta.url), [ctx.file.href, emailUrl, PRIMARY_URL], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      workers.set(worker.pid, worker);
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      ctx.defer(async () => {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
        const timer = setTimeout(() => worker.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(timer);
      });
    }

    // Wait until no job is queued, and no worker is in the middle of one.
    const deadline = Date.now() + 20_000;
    let queued;
    while (Date.now() < deadline) {
      ({ rows: [{ queued }] } = await db.query("SELECT count(*)::int AS queued FROM jobs WHERE status = 'queued'"));
      if (queued === 0) break;
      await sleep(100);
    }
    await sleep(300);

    const problems = [];
    if (queued > 0) {
      problems.push(`After 20 seconds, ${count(queued, "job")} still waited in the queue.`);
    }
    for (const to of [KILL_AFTER_SEND, KILL_BEFORE_SEND]) {
      if (!killed.some((k) => k.to === to)) {
        problems.push(`No worker ever sent ${to}'s email, so the test couldn't kill a worker during it.`);
      }
    }

    const { rows: sent } = await db.query("SELECT to_address, count(*)::int AS n FROM sent_emails GROUP BY to_address");
    const sentTo = new Map(sent.map((row) => [row.to_address, row.n]));
    for (const { to } of CUSTOMERS) {
      const n = sentTo.get(to) ?? 0;
      if (n === 1) continue;
      const when =
        to === KILL_AFTER_SEND
          ? " A worker died after the provider delivered it, before the worker marked the job done."
          : to === KILL_BEFORE_SEND
            ? " A worker died while it sent it, before the provider delivered anything."
            : "";
      problems.push(
        n === 0
          ? `${to} never got a welcome email.${when}`
          : `${to} got the welcome email ${n} times.${when} Another worker took the job and sent it again.`,
      );
    }
    return problems;
  },
};
