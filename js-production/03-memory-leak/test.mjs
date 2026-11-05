// Runs 300 upload jobs through the worker, one after another, the way the queue hands them out.
// Every 7th upload isn't an image, so 39 jobs fail. Every 10th job uploads the same file as a job
// 3 jobs before it.
//
// The test keeps a WeakRef to each job, each thumbnail, and each signal the worker passes to
// storage.save, and nothing else. After the jobs, it runs the garbage collector (Node runs the
// lab with --expose-gc) and counts what's still alive. So the result doesn't depend on timing or
// on how much memory the machine has.
//
// Then it checks what should stay: the dashboard's last 50 jobs, the thumbnail cache for a file
// uploaded again, and that a "stop" from the queue still stops a running job's save.

import { count, describeError, loadModule, within } from "../lib/helpers.mjs";
import { createImages, createQueue, createStorage, isBroken, isReupload, makeJob } from "./fixtures.mjs";

const JOBS = 300;
const MAX_THUMBNAILS = 100;
const MAX_RECENT = 50;
const SLACK = 2; // objects the last job or two can still hold for a moment
const MB = 1024 * 1024;

export default {
  file: "worker.mjs",
  lesson: "https://atomicly.dev/lessons/js-finding-a-leak",

  async run({ file, collectGarbage, events }) {
    const loaded = await loadModule(file, ["createUploadWorker"]);
    if (loaded.problems) return loaded.problems;

    const thumbnails = [];
    const signals = [];
    const failedJobs = [];
    const done = [];
    let resizes = 0;

    const queue = createQueue();
    const images = createImages((thumbnail) => {
      resizes++;
      thumbnails.push(new WeakRef(thumbnail));
    });
    const storage = createStorage((jobId, signal) => {
      if (signal) signals.push(new WeakRef(signal));
    });
    const worker = loaded.app.createUploadWorker({ queue, images, storage });
    if (typeof worker?.handle !== "function" || typeof worker?.status !== "function") {
      return ["createUploadWorker should return { handle, status }."];
    }

    let unexpected = null;
    for (let n = 0; n < JOBS; n++) {
      const outcome = await within(runJob(worker, n, failedJobs), 2000);
      if (outcome.timedOut) return [`The job for upload ${n} never finished.`];
      if (outcome.value === "done") done.push(makeJob(n).id);
      if (outcome.value?.unexpected) unexpected ??= outcome.value.unexpected;
    }
    await collectGarbage();

    const problems = [];
    if (unexpected) problems.push(unexpected);

    // 1. The "stop" listeners on the queue.
    const listeners = queue.listenerCount("stop");
    const signalsAlive = alive(signals);
    const warning = events.warnings.find((item) => item.name === "MaxListenersExceededWarning");
    events.warnings = events.warnings.filter((item) => item !== warning);
    if (listeners > SLACK || signalsAlive > SLACK) {
      problems.push(
        `After ${JOBS} jobs, the queue has ${count(listeners, '"stop" listener')}, one for each job that ever ran` +
          (warning ? ", and Node printed MaxListenersExceededWarning" : "") +
          ". The queue lives as long as the process, so it keeps each of those jobs' AbortControllers alive.",
      );
    }

    // 2. The failed jobs.
    const failedAlive = alive(failedJobs);
    const stillRunning = worker.status().running ?? [];
    const failedLeak = failedAlive > SLACK || stillRunning.length > 0;
    if (failedLeak) {
      problems.push(
        `${count(failedAlive, "failed job")} ${failedAlive === 1 ? "is" : "are"} still in memory, with ` +
          `${((failedAlive * makeJob(0).upload.byteLength) / MB).toFixed(1)} MB of uploads, and the dashboard lists ` +
          `${count(stillRunning.length, "job")} as running, such as ${stillRunning[0] ?? failedJobs[0]?.id}. ` +
          `Those jobs failed and ended long ago.`,
      );
    }

    // 3. The thumbnail cache.
    const thumbnailsAlive = alive(thumbnails);
    if (thumbnailsAlive > MAX_THUMBNAILS + SLACK) {
      problems.push(
        `After ${JOBS} jobs, ${thumbnailsAlive} thumbnails are still in memory, one for each file ever uploaded. ` +
          `The worker has room for ${MAX_THUMBNAILS}, and the next week of uploads adds thousands more.`,
      );
    }
    const unique = Array.from({ length: JOBS }, (_, n) => n).filter((n) => !isBroken(n) && !isReupload(n)).length;
    if (resizes > unique) {
      problems.push(
        `${count(resizes - unique, "file")} uploaded again 3 jobs later got a new thumbnail. ` +
          `The cache should still have it: keep the newest ${MAX_THUMBNAILS} thumbnails, not none.`,
      );
    }

    // 4. The dashboard's recent jobs, which don't leak.
    const recent = worker.status().recent ?? [];
    const want = done.slice(-MAX_RECENT);
    if (recent.length !== want.length || recent.some((id, i) => id !== want[i])) {
      problems.push(
        `The dashboard shows ${count(recent.length, "recent job")}, and it should show the last ${MAX_RECENT} that ` +
          `finished, from ${want[0]} to ${want.at(-1)}. recentJobs drops its oldest entry for each new one, ` +
          "so it never grows past 50. Keep it.",
      );
    }

    // 5. A "stop" from the queue still stops the save of a job that's running.
    storage.hangFor = makeJob(JOBS, "stop").id;
    let stopSignal = null;
    const stopStorage = storage.save;
    storage.save = (jobId, thumbnail, options) => {
      if (jobId === storage.hangFor) stopSignal = options?.signal ?? null;
      return stopStorage(jobId, thumbnail, options);
    };
    const stopping = within(worker.handle(makeJob(JOBS, "stop")), 1000);
    await new Promise((resolve) => setImmediate(resolve));
    queue.emit("stop");
    const stopped = await stopping;
    if (stopped.timedOut || !stopSignal?.aborted) {
      problems.push(
        'When the queue emitted "stop", the running job\'s save kept going. ' +
          "A deploy would wait for it, or cut it off halfway. Keep the listener while the job runs.",
      );
    } else if (!failedLeak && (worker.status().running ?? []).includes(storage.hangFor)) {
      problems.push(`The job that "stop" ended is still on the dashboard as running.`);
    }

    return problems;
  },
};

// Runs job n. Returns "done", "failed", or { unexpected } when the outcome doesn't fit the job.
async function runJob(worker, n, failedJobs) {
  const job = makeJob(n);
  const broken = isBroken(n) && !isReupload(n);
  if (broken) failedJobs.push(Object.assign(new WeakRef(job), { id: job.id }));
  try {
    await worker.handle(job);
  } catch (error) {
    if (broken) return "failed";
    return { unexpected: `The job ${job.id}, a valid image, failed with ${describeError(error)}.` };
  }
  if (broken) return { unexpected: `The job ${job.id}, an upload that isn't an image, didn't fail.` };
  return "done";
}

function alive(refs) {
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

