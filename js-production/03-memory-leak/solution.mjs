// The upload worker. See worker.mjs for what createUploadWorker gets and what status() returns.
//
// Three things leaked, and one didn't:
// - Each job added a "stop" listener to the queue, which lives as long as the process, and
//   nothing removed it. Each listener kept its job's AbortController.
// - A job that failed never reached running.delete, so the map kept the job and its upload.
// - The thumbnail cache got a new entry for each new file, with no limit.
// - recentJobs is fine: it drops the oldest summary for each new one, so it stays at 50.

const MAX_THUMBNAILS = 100;
const MAX_RECENT = 50;

class JobSummary {
  constructor(id, userId, finishedAt) {
    this.id = id;
    this.userId = userId;
    this.finishedAt = finishedAt;
  }
}

export function createUploadWorker({ queue, images, storage }) {
  const running = new Map(); // job id -> job, for the dashboard
  const recentJobs = []; // the last 50 finished jobs, newest last
  const thumbnails = new Map(); // file hash -> thumbnail, the 100 newest

  async function handle(job) {
    running.set(job.id, job);
    const controller = new AbortController();
    const onStop = () => controller.abort();
    queue.on("stop", onStop);
    try {
      const thumbnail = thumbnailFor(job);
      await storage.save(job.id, thumbnail, { signal: controller.signal });
      recentJobs.push(new JobSummary(job.id, job.userId, Date.now()));
      if (recentJobs.length > MAX_RECENT) recentJobs.shift();
    } finally {
      // Every way out of the job, success or failure, removes what the job added.
      queue.off("stop", onStop);
      running.delete(job.id);
    }
  }

  function thumbnailFor(job) {
    const cached = thumbnails.get(job.fileHash);
    if (cached) return cached;
    const thumbnail = images.resize(job.upload);
    if (thumbnails.size >= MAX_THUMBNAILS) {
      const oldestHash = thumbnails.keys().next().value;
      thumbnails.delete(oldestHash);
    }
    thumbnails.set(job.fileHash, thumbnail);
    return thumbnail;
  }

  function status() {
    return {
      running: [...running.keys()],
      recent: recentJobs.map((summary) => summary.id),
    };
  }

  return { handle, status };
}
