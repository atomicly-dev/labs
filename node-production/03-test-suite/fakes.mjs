// In-memory storage for your tests. createWriteStream(name) keeps the file in files when the
// stream finishes. A stream destroyed before that, by a byte limit or a client that left, keeps
// nothing, and its name goes on discarded.

import { Readable, Writable } from "node:stream";

export function createStorage() {
  const files = new Map(); // name -> Buffer
  const discarded = [];
  return {
    files,
    discarded,
    createWriteStream(name) {
      const chunks = [];
      let done = false;
      return new Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          done = true;
          files.set(name, Buffer.concat(chunks));
          callback();
        },
        destroy(error, callback) {
          if (!done) discarded.push(name);
          callback(error);
        },
      });
    },
    createReadStream(name) {
      if (!files.has(name)) throw Object.assign(new Error(`No such file: ${name}`), { code: "ENOENT" });
      return Readable.from([files.get(name)]);
    },
  };
}
