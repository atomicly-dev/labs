// The upload worker. It runs for weeks without a restart. For each upload job from the queue, it
// makes a thumbnail of the uploaded image and saves it to storage. The test, and
// snapshots.mjs, call createUploadWorker once, then handle(job) for each job.
//
// createUploadWorker gets:
//   queue    The queue client, an EventEmitter that lives as long as the process. It emits
//            "stop" before a deploy, and the jobs that are running then should stop their save.
//   images   images.resize(upload) returns a Thumbnail. It throws when the upload isn't an image.
//   storage  storage.save(jobId, thumbnail, { signal }) saves it, and stops when the signal aborts.
//
// A job is an UploadJob: { id, userId, fileHash, upload }, where upload holds the file's bytes.
// Two uploads of the same file have the same fileHash. The worker has room for 100 thumbnails
// in memory.
//
// status() feeds the ops dashboard: the ids of the jobs running now, and of the last 50 jobs that
// finished.

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
  const thumbnails = new Map(); // file hash -> thumbnail, so a file uploaded again skips the resize

  async function handle(job) {
    running.set(job.id, job);

    // Stop the save when the queue says stop.
    const controller = new AbortController();
    queue.on("stop", () => controller.abort());

    let thumbnail = thumbnails.get(job.fileHash);
    if (!thumbnail) {
      thumbnail = images.resize(job.upload);
      thumbnails.set(job.fileHash, thumbnail);
    }
    await storage.save(job.id, thumbnail, { signal: controller.signal });

    running.delete(job.id);
    recentJobs.push(new JobSummary(job.id, job.userId, Date.now()));
    if (recentJobs.length > 50) recentJobs.shift();
  }

  function status() {
    return {
      running: [...running.keys()],
      recent: recentJobs.map((summary) => summary.id),
    };
  }

  return { handle, status };
}
