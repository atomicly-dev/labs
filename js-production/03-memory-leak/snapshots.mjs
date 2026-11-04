// npm run snapshots: runs the worker the way production does, and writes two heap snapshots to
// this folder, so you can compare them in Chrome DevTools.
//
// It runs 100 jobs to warm up, writes before.heapsnapshot, runs 500 more jobs, and writes
// after.heapsnapshot. Pass another file to look at it instead of worker.mjs:
//   npm run snapshots -- solution.mjs

import { writeHeapSnapshot } from "node:v8";
import { createImages, createQueue, createStorage, makeJob } from "./fixtures.mjs";

const here = new URL("./", import.meta.url);
const file = new URL(process.argv[2] ?? "worker.mjs", here);
const { createUploadWorker } = await import(file.href);

const worker = createUploadWorker({ queue: createQueue(), images: createImages(), storage: createStorage() });

async function runJobs(from, to) {
  for (let n = from; n < to; n++) {
    await worker.handle(makeJob(n)).catch(() => {}); // the queue retries failed jobs later
  }
}

function snapshot(name) {
  const path = new URL(name, here).pathname;
  writeHeapSnapshot(path);
  // The uploads' bytes live in ArrayBuffers, outside V8's heap, so the total counts them too.
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  console.log(`Wrote ${name}. Memory in use: ${Math.round((heapUsed + arrayBuffers) / 1024 / 1024)} MB.`);
}

await runJobs(0, 100);
snapshot("before.heapsnapshot");
await runJobs(100, 600);
snapshot("after.heapsnapshot");
console.log("Load both files in Chrome DevTools' Memory panel, select after.heapsnapshot, and pick Comparison.");
