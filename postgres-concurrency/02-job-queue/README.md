# Lab 02: Job queue

Lesson: [Row locks](https://atomicly.dev/lessons/row-locks)

## The situation

After a customer pays, the shop queues a job to send their receipt. Four workers take jobs from the `jobs` table, and each one runs `claim.sql`:

1. It takes the oldest queued job.
2. It does the job. Here, it logs a row in `job_runs`, in place of sending an email.
3. It marks the job done.

With one worker, the jobs go out one by one. With four, the same customer gets four copies of the same receipt.

## What's wrong

All four workers read the queue at the same moment, and each one picks job 1. Nothing stops a second worker from taking a job that another worker is busy with.

## What passing looks like

Each of the four workers takes a different job, each job runs once, and no worker waits for a lock that another worker holds.

```sh
npm run lab -- 02
```

The test runs `claim.sql` in 4 sessions with `:worker` set to `'worker-1'` through `'worker-4'`. There are 6 queued jobs.

## Hint

Lock the job you take, so no other worker can take it. A plain lock isn't enough: the other workers then wait for job 1 to finish. Look for the locking option that passes over rows other sessions have locked.
