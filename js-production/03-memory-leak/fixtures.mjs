// The upload jobs and the fake services that test.mjs and snapshots.mjs give the worker. They're
// classes, so each one has its own name in a heap snapshot.

import { EventEmitter } from "node:events";

const UPLOAD_BYTES = 64 * 1024;
const THUMBNAIL_BYTES = 8 * 1024;

export class UploadJob {
  constructor(id, userId, fileHash, upload) {
    this.id = id;
    this.userId = userId;
    this.fileHash = fileHash;
    this.upload = upload;
  }
}

export class Thumbnail {
  constructor(width, height, bytes) {
    this.width = width;
    this.height = height;
    this.bytes = bytes;
  }
}

// Job n: every 7th upload, starting with the 4th, isn't an image, so its job fails. Every 10th
// job uploads the same file as a job 3 jobs before it, as when a user uploads the same photo
// again.
export function isBroken(n) {
  return n % 7 === 3;
}

export function isReupload(n) {
  return n % 10 === 9;
}

function sourceOf(n) {
  if (!isReupload(n)) return n;
  return isBroken(n - 3) ? n - 2 : n - 3;
}

/** Makes job n. Each call makes a new job object and a new upload, as a real queue does. */
export function makeJob(n, prefix = "job") {
  const file = sourceOf(n);
  const upload = new Uint8Array(UPLOAD_BYTES);
  upload[0] = isBroken(file) ? 0x00 : 0x89; // 0x89 starts a PNG file
  upload[1] = file % 256;
  return new UploadJob(`${prefix}-${1000 + n}`, 500 + (n % 37), `sha256-${(file * 2654435761) % 2 ** 32}`, upload);
}

/** The image library. resize throws for an upload that isn't an image. */
export function createImages(onResize = () => {}) {
  return {
    resize(upload) {
      if (upload[0] !== 0x89) throw new Error("The upload isn't an image");
      const thumbnail = new Thumbnail(200, 200, new Uint8Array(THUMBNAIL_BYTES));
      onResize(thumbnail);
      return thumbnail;
    },
  };
}

/**
 * The storage service. save takes a turn of the event loop, and stops when the signal aborts.
 * When hangFor is set to a job's id, the save for that job waits until its signal aborts.
 */
export function createStorage(onSave = () => {}) {
  const storage = {
    hangFor: null,
    async save(jobId, thumbnail, { signal } = {}) {
      onSave(jobId, signal);
      if (jobId === storage.hangFor) {
        await new Promise((resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    },
  };
  return storage;
}

/** The queue client. It lives as long as the process, and emits "stop" before a deploy. */
export function createQueue() {
  return new EventEmitter();
}
