// Black Friday: the team scales the API from 2 instances to 4. The test restarts the API
// containers with your config.mjs, scales them to 4 behind nginx, and sends 600 cart-total
// requests, 64 at a time. Each request holds a database connection for 100 ms.
//
// PostgreSQL allows 20 connections, and keeps 3 for superusers, so the API's role gets 17. At
// 100 ms a request, 17 connections can serve up to 170 requests a second.

import { count, startApi } from "../lib/helpers.mjs";
import { load } from "../lib/load.mjs";
import { API_URL } from "../lib/urls.mjs";

const LAB = "01-find-the-bottleneck";
const INSTANCES = 4;
const REQUESTS = 600;
const CONNECTIONS = 64;
const APP_SLOTS = 17;
// 4 pools of 4 connections serve about 150 requests a second here. Pools that hold 8 connections
// in all serve about 80.
const MIN_PER_SECOND = 110;

export default {
  file: "config.mjs",
  lesson: "https://atomicly.dev/lessons/sd-first-bottleneck",

  async run(ctx) {
    const started = await startApi({ lab: LAB, file: ctx.fileName, instances: INSTANCES });
    if (started.problems) return started.problems;
    const { health } = started;
    const maxes = health.map((instance) => instance.poolMax);
    const total = maxes.reduce((sum, max) => sum + max, 0);
    const pools = maxes.every((max) => max === maxes[0]) ? `${INSTANCES} pools × ${maxes[0]}` : maxes.join(" + ");

    const result = await load({
      url: `${API_URL}/cart-total?product=3&quantity=2`,
      requests: REQUESTS,
      connections: CONNECTIONS,
    });

    const problems = [];
    const failed = REQUESTS - (result.statuses.get(200) ?? 0);
    if (failed) {
      problems.push(`${failed} of ${REQUESTS} requests failed:`);
      for (const [message, n] of result.errors) problems.push(`  ${n} × ${message}`);
      problems.push(
        `With ${INSTANCES} instances, the pools can open up to ${total} connections (${pools}), ` +
          `and PostgreSQL has ${APP_SLOTS} for the app. The instances that connect last get none.`,
      );
    }
    const wrong = result.bodies.filter((b) => b.status === 200 && b.body?.total !== "29.98").length;
    if (wrong) problems.push(`${count(wrong, "request")} got the wrong total. 2 water bottles cost 29.98.`);

    const perSecond = Math.round(result.perSecond);
    if (!failed && perSecond < MIN_PER_SECOND) {
      problems.push(
        `Every request succeeded, but the API served only ${perSecond} requests a second, and it should serve at least ${MIN_PER_SECOND}. ` +
          `The pools hold ${total} connections in all (${pools}), and PostgreSQL has room for ${APP_SLOTS}. ` +
          "Requests wait for a pool connection while the database has free ones.",
      );
    }
    if (failed) {
      const served = Math.round((REQUESTS - failed) / result.seconds);
      problems.push(`The API served ${served} successful requests a second.`);
    }
    return problems;
  },
};
