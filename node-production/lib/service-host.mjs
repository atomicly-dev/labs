// The service's own process. lib/service.mjs starts it with the file to run and the fakes'
// settings. It imports the file, calls createService with fake storage, a fake database pool,
// and fake telemetry, and listens on a random port on 127.0.0.1.
//
// The fakes record what happens to them. Events that must survive process.exit, such as the
// pool closing, go to a file with appendFileSync, so a fast exit can't lose them. The test asks
// for the rest over the IPC channel.

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const [fileHref, settingsJson] = process.argv.slice(2);
const settings = JSON.parse(settingsJson);
const start = performance.now();

// The service exits when the test's process goes away, so a killed lab leaves nothing running.
process.on("disconnect", () => process.exit(0));

function record(event, fields = {}) {
  appendFileSync(settings.eventsFile, `${JSON.stringify({ event, at: Math.round(performance.now() - start), ...fields })}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Storage keeps a file only when its stream finishes. A stream destroyed before that is
// discarded, as with a real object store's multipart upload.
const files = new Map(); // name -> bytes
const discarded = [];
let storedBytes = 0;
let openStreams = 0;
let peakOpenStreams = 0;

const storage = {
  createWriteStream(name) {
    let bytes = 0;
    let done = false;
    openStreams++;
    peakOpenStreams = Math.max(peakOpenStreams, openStreams);
    const close = () => {
      if (!done) openStreams--;
      done = true;
    };
    return new Writable({
      write(chunk, encoding, callback) {
        sampleHeld();
        bytes += chunk.length;
        storedBytes += chunk.length;
        setTimeout(callback, settings.storageWriteMs ?? 0);
      },
      final(callback) {
        files.set(name, bytes);
        close();
        callback();
      },
      destroy(error, callback) {
        if (!done) discarded.push(name);
        close();
        callback(error);
      },
    });
  },
  createReadStream(name) {
    if (!files.has(name)) throw Object.assign(new Error(`No such file: ${name}`), { code: "ENOENT" });
    return Readable.from([Buffer.alloc(files.get(name), "r")]);
  },
};

// The bytes the service has read from its sockets and not yet passed to storage. That's the
// upload it holds in memory.
const sockets = new Set();
let closedBytesRead = 0;
let heldBaseline = 0;
let peakHeld = 0;
function held() {
  let read = closedBytesRead;
  for (const socket of sockets) read += socket.bytesRead;
  return read - storedBytes;
}
function sampleHeld() {
  peakHeld = Math.max(peakHeld, held() - heldBaseline);
}

// A pool with the pg package's errors. A query in progress when the pool ends fails, and so
// does every query after it.
let poolEnded = false;
const runningQueries = new Set();
const pool = {
  async query(sql, params = []) {
    if (poolEnded) {
      record("query-failed", { sql, params, error: "Cannot use a pool after calling end on the pool" });
      throw new Error("Cannot use a pool after calling end on the pool");
    }
    const query = { sql, params };
    runningQueries.add(query);
    try {
      if (settings.stuckQuery && params.includes(settings.stuckQuery)) {
        record("query-stuck", { sql, params });
        // A row lock that never goes away. The query's connection stays open, so it keeps the
        // process alive, as a real one does.
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
      await sleep(settings.queryMs ?? 0);
      if (poolEnded) {
        record("query-failed", { sql, params, error: "Connection terminated" });
        throw new Error("Connection terminated");
      }
      record("query-done", { sql, params });
      return { rowCount: 1, rows: [] };
    } finally {
      runningQueries.delete(query);
    }
  },
  async end() {
    poolEnded = true;
    record("pool-end", { running: runningQueries.size });
  },
};

const telemetry = {
  async shutdown() {
    record("telemetry-shutdown");
    await sleep(settings.flushMs ?? 0);
    record("telemetry-flushed");
  },
};

const originalExit = process.exit;
process.exit = (code) => {
  record("exit", { code: code ?? 0 });
  originalExit(code);
};
process.on("SIGTERM", () => record("sigterm"));

let mod;
try {
  mod = await import(fileHref);
} catch (error) {
  process.send({ type: "error", message: `doesn't load: ${error.message}` });
}
if (mod && typeof mod.createService !== "function") {
  process.send({ type: "error", message: "doesn't export a function called createService." });
} else if (mod) {
  const server = mod.createService({ storage, taxUrl: settings.taxUrl, pool, telemetry });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      closedBytesRead += socket.bytesRead;
    });
  });
  const sampler = setInterval(sampleHeld, 2);
  sampler.unref();
  server.listen(0, "127.0.0.1", () => {
    process.send({ type: "ready", port: server.address().port });
  });

  process.on("message", (message) => {
    if (message.type === "reset-held") {
      heldBaseline = held();
      peakHeld = 0;
      process.send({ type: "reply", id: message.id });
    } else if (message.type === "stats") {
      sampleHeld();
      process.send({
        type: "reply",
        id: message.id,
        value: { files: Object.fromEntries(files), discarded, peakHeld, openStreams, peakOpenStreams },
      });
    }
  });

  // The IPC channel doesn't keep the process alive, so a service that closes everything exits on
  // its own, as it would in production.
  process.channel?.unref();
}
