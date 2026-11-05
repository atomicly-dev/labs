// The partner API runs as 4 instances behind nginx, and each partner may make 10 requests a
// minute. The test restarts the API containers with your limiter.mjs, then one partner sends 60
// requests, 20 at a time, and a second partner sends 30. Each partner should get exactly 10
// answers of 200, and 429 for the rest.
//
// Each run uses new API keys, so a run doesn't count the requests of the run before it.

import { randomUUID } from "node:crypto";
import { startApi } from "../lib/helpers.mjs";
import { load } from "../lib/load.mjs";
import { API_URL } from "../lib/urls.mjs";

const LAB = "06-limit-across-replicas";
const INSTANCES = 4;
const LIMIT = 10;

export default {
  file: "limiter.mjs",
  lesson: null,

  async run(ctx) {
    const started = await startApi({ lab: LAB, file: ctx.fileName, instances: INSTANCES });
    if (started.problems) return started.problems;
    const run = randomUUID().slice(0, 8);
    const problems = [];

    for (const { partner, requests } of [
      { partner: "acme", requests: 60 },
      { partner: "globex", requests: 30 },
    ]) {
      const result = await load({
        url: `${API_URL}/orders`,
        requests,
        connections: 20,
        headers: { "x-api-key": `${partner}-${run}` },
      });
      const allowed = result.statuses.get(200) ?? 0;
      const limited = result.statuses.get(429) ?? 0;
      const instances = new Set(result.bodies.filter((b) => b.status === 200).map((b) => b.body?.instance));
      if (allowed + limited !== requests) {
        problems.push(`${requests - allowed - limited} of ${partner}'s ${requests} requests got neither 200 nor 429:`);
        for (const [message, n] of result.errors) problems.push(`  ${n} × ${message}`);
        continue;
      }
      if (allowed > LIMIT) {
        problems.push(
          `${partner} sent ${requests} requests, 20 at a time, and ${allowed} got through, ${instances.size === 1 ? "all on 1 instance" : `spread over ${instances.size} instances`}. ` +
            `The limit is ${LIMIT} a minute, for the whole API.`,
        );
      } else if (allowed < LIMIT) {
        problems.push(
          `${partner} sent ${requests} requests, its first of the minute, and only ${allowed} got through. ` +
            `A partner may make ${LIMIT} a minute.`,
        );
      }
    }
    return problems;
  },
};
