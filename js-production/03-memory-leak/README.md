# Lab 03: Memory leak

Lessons: [Find a memory leak](https://atomicly.dev/lessons/js-finding-a-leak), [Memory leaks in long-running code](https://atomicly.dev/lessons/js-memory-leaks), and [Listeners and timers that never stop](https://atomicly.dev/lessons/js-listeners-and-timers)

## The situation

The upload worker makes a thumbnail for each image a user uploads. `createUploadWorker` in `worker.mjs` runs for weeks without a restart. For each job from the queue, `handle(job)`:

1. Adds the job to `running`, for the ops dashboard.
2. Adds a `"stop"` listener to the queue, so a deploy can stop the job's save.
3. Gets the thumbnail from the cache, or makes one with `images.resize`. A file uploaded again has the same `fileHash`, so it skips the resize.
4. Saves the thumbnail, then moves the job from `running` to `recentJobs`, a list of the last 50 jobs.

Some uploads aren't images. For those, `images.resize` throws, and the job fails.

## What users see

The worker's memory grows all week, until it crashes with `JavaScript heap out of memory` and restarts. The ops dashboard lists jobs as running that failed days ago. And the logs have a `MaxListenersExceededWarning` nobody looked at.

## Find the leak first

The worker keeps 4 things that live as long as the process: the `running` map, the queue's listeners, the thumbnail cache, and `recentJobs`. Each one looks like it could leak. Find out which ones do before you change anything:

```sh
npm run snapshots
```

This runs the worker with 100 jobs to warm up, writes `before.heapsnapshot`, runs 500 more jobs, and writes `after.heapsnapshot`, both in this folder. Then:

1. Open Chrome's DevTools on any page, and go to the Memory panel.
2. Load both files.
3. Select `after.heapsnapshot`, and switch its view from Summary to Comparison, against `before.heapsnapshot`.
4. Look at the # Delta column for `UploadJob`, `Thumbnail`, `AbortController`, and `JobSummary`. The jobs and thumbnails are classes, so each one has its own row.
5. Expand a row with a large delta, select one of the new objects, and read its Retainers, up to the variable that holds it.

Write down, in a sentence each, which structures leak, and why one of the 4 doesn't. Then fix the ones that leak. To check your fix the same way, run `npm run snapshots` again: the deltas should drop to about zero.

In a real worker, you'd take the snapshots from the running process. Start it with `node --heapsnapshot-signal=SIGUSR2 worker.js`, and each `kill -USR2 <pid>` writes a snapshot. Or call `writeHeapSnapshot()` from `node:v8` in your code.

## What passing looks like

```sh
npm run lab -- 03
```

The test runs 300 jobs through your worker, one after another. 39 of them fail, because their upload isn't an image, and 30 upload a file again, 3 jobs after the first upload. The test keeps a `WeakRef` to each job, each thumbnail, and each signal your worker passes to `storage.save`. After the jobs, it runs the garbage collector and counts what's still alive. So the result doesn't depend on timing or on how much memory your machine has.

The lab passes when:

- No `"stop"` listener is left on the queue after the jobs, and Node prints no `MaxListenersExceededWarning`.
- No failed job is still in memory, and the dashboard lists no job as running.
- At most 100 thumbnails are in memory, and a file uploaded again 3 jobs later still gets its thumbnail from the cache.
- The dashboard still shows the last 50 jobs that finished.
- A `"stop"` from the queue still stops the save of a job that's running.

## Hints

- **Reading the snapshots.** Sections 3 and 4 of [Find a memory leak](https://atomicly.dev/lessons/js-finding-a-leak), *Compare two snapshots* and *Follow the retainers to the code*, show how. The end of section 4 explains why a list with a size limit shows up in the retainers but not in # Delta.
- **The listeners.** Section 1 of [Listeners and timers that never stop](https://atomicly.dev/lessons/js-listeners-and-timers), *A listener stays in the emitter's list*, shows why a listener on a long-lived emitter keeps what it uses. Section 2, *Node warns after 10 listeners*, explains the warning. Section 3, *To remove a listener, pass the same function*, shows how to remove it, and why `once` doesn't help when the event never comes.
- **The failed jobs.** Section 2 of [Memory leaks in long-running code](https://atomicly.dev/lessons/js-memory-leaks), *Delete entries when their work ends*, shows a map that keeps an entry for each job that throws.
- **The cache.** Section 3 of the same lesson, *Give a cache a size limit*, shows how to drop the oldest entry.
