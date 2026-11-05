# Lab 04: Kill the worker

Lessons: [Row locks](https://atomicly.dev/lessons/row-locks) (section 4, *SKIP LOCKED for a job queue*) and [Idempotent writes](https://atomicly.dev/lessons/idempotency), and [Message queues: acknowledge after the effect](https://atomicly.dev/lessons/sd-message-queues)

## The situation

When a customer signs up, the API adds a welcome-email job to the `jobs` table. Worker processes take jobs with `FOR UPDATE SKIP LOCKED`, call the email provider, and mark each job done. The code is in `worker.mjs`.

The queue survives crashes, and the team is proud of it: if a worker dies, PostgreSQL rolls back its transaction, the row lock goes away, and another worker takes the job. Nothing gets lost.

Then the team deploys during a sign-up rush, and the deploy kills the old workers mid-job. The next morning, support has emails from customers who got the welcome email twice, with the same discount code.

## Try it

```sh
npm run lab -- 04
```

The test queues 6 welcome emails, starts 3 workers, and plays the email provider. It kills 2 workers with `SIGKILL`, the way a deploy, a crash, or the out-of-memory killer does:

- One dies right after the provider delivered Chen's email, before the worker got the answer.
- One dies while it sends Emeka's email, before the provider delivered anything.

Then look at what the provider delivered:

```sh
npm run db -- -c "SELECT to_address, idempotency_key, sent_at FROM sent_emails ORDER BY id"
```

## What's wrong

The queue redelivered Chen's job, as designed. The worker that died had sent the email, but it never committed `done`, so from the database's side the job never ran. The second worker sent it again.

A queue like this delivers each job at least once. No queue can tell "the worker died before the side effect" from "the worker died after it", so each job's side effect has to be safe to run twice.

## What passing looks like

Each of the 6 customers gets exactly 1 welcome email, and no job stays queued. Emeka's email must still arrive: don't fix the duplicate by losing an email.

## Hint

Fix `worker.mjs`. The email provider supports idempotency keys, like most email and payment APIs: see `lib/email.mjs`. When it gets a key it has seen before, it doesn't send again. Which value stays the same on every try of the same job, and differs between jobs?
