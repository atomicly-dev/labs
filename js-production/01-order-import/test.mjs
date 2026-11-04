// Runs importOrders against two real HTTP servers on random ports:
//
// - The partner's API serves 60 orders, 10 per page, in 6 pages. Each page takes 20 ms.
// - The orders service takes 40 ms to save an order. It handles 5 requests at a time and answers
//   429 to any more. It answers 422 to the 2 invalid orders, 1017 and 1044. And it never answers
//   the save of order 1033, as when a database lock holds it up.
//
// The test records each request the two servers get, then checks the import from their side.

import { count, describeError, list, loadModule, readJson, sendJson, sleep, within } from "../lib/helpers.mjs";

const PAGE_SIZE = 10;
const PAGES = 6;
const LIMIT = 5;
const SAVE_MS = 40;
const PAGE_MS = 20;
const INVALID = new Map([
  [1017, "total is missing"],
  [1044, "currency XXX isn't supported"],
]);
const HUNG = 1033;
const DEADLINE_MS = 10_000;

const ORDERS = Array.from({ length: PAGE_SIZE * PAGES }, (_, i) => {
  const id = 1001 + i;
  return {
    id,
    customer: `cus_${(id * 7919) % 100_000}`,
    total: id === 1017 ? null : Math.round(((id * 37) % 500) * 100 + 99) / 100,
    currency: id === 1044 ? "XXX" : "EUR",
  };
});
const pageOf = (id) => Math.floor((id - 1001) / PAGE_SIZE) + 1;
const GOOD = ORDERS.filter((order) => !INVALID.has(order.id) && order.id !== HUNG).map((order) => order.id);
const SHOULD_FAIL = [...INVALID.keys(), HUNG].sort();

export default {
  file: "importer.mjs",
  lesson: "https://atomicly.dev/lessons/concurrency-limits",

  async run({ file, serve }) {
    const loaded = await loadModule(file, ["importOrders"]);
    if (loaded.problems) return loaded.problems;
    const { importOrders } = loaded.app;

    // What the orders service saw.
    const received = new Set(); // ids of orders that reached it, not counting 429s
    const sends = new Map(); // id -> how many times it got that order, not counting 429s
    const saved = new Set();
    let active = 0;
    let peak = 0;
    let tooMany = 0;
    let lastArrival = 0;
    let hungOpen = 0; // saves of the hung order that are still open
    let hungClosed = () => {};

    // What the partner's API saw: for each page request, the orders the service had by then.
    const pageRequests = [];

    const partnerUrl = await serve(async (req, res) => {
      const url = new URL(req.url, "http://partner");
      if (req.method !== "GET" || url.pathname !== "/orders") return sendJson(res, 404, { error: "not found" });
      const cursor = url.searchParams.get("cursor");
      const page = cursor === null ? 1 : Number(/^p(\d+)$/.exec(cursor)?.[1]);
      if (!(page >= 1 && page <= PAGES)) return sendJson(res, 400, { error: `unknown cursor ${cursor}` });
      pageRequests.push({ page, received: new Set(received) });
      await sleep(PAGE_MS);
      sendJson(res, 200, {
        orders: ORDERS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        nextCursor: page < PAGES ? `p${page + 1}` : null,
      });
    });

    const storeUrl = await serve(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/orders") return sendJson(res, 404, { error: "not found" });
      // A request counts from the moment it arrives until its response closes.
      let counted = true;
      lastArrival = Date.now();
      active++;
      peak = Math.max(peak, active);
      res.on("close", () => {
        if (counted) active--;
      });
      if (active > LIMIT) {
        tooMany++;
        return sendJson(res, 429, { error: "Too Many Requests" });
      }
      let order;
      try {
        order = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "the body isn't JSON" });
      }
      // The save that never answers stops counting toward the limit once the service has read
      // it, so a timeout that frees its slot can't race the next request.
      if (order.id === HUNG) {
        counted = false;
        active--;
        received.add(order.id);
        sends.set(order.id, (sends.get(order.id) ?? 0) + 1);
        hungOpen++;
        res.on("close", () => {
          hungOpen--;
          if (hungOpen === 0) hungClosed();
        });
        return;
      }
      received.add(order.id);
      sends.set(order.id, (sends.get(order.id) ?? 0) + 1);
      await sleep(SAVE_MS);
      if (INVALID.has(order.id)) return sendJson(res, 422, { error: INVALID.get(order.id) });
      saved.add(order.id);
      sendJson(res, 201, { id: order.id });
    });

    const outcome = await within(importOrders({ partnerUrl, storeUrl }), DEADLINE_MS);
    // The service sees a timed-out request close a moment after the import gives up on it.
    if (hungOpen) await within(new Promise((resolve) => (hungClosed = resolve)), 1000);
    // An import that fails can leave saves on their way. Let them arrive, so the numbers below
    // count them. This wait changes only the numbers in the messages, not whether the lab passes.
    for (let waited = 0; waited < 1000 && (active > 0 || Date.now() - lastArrival < 100); waited += 20) {
      await sleep(20);
    }

    const problems = [];

    if (outcome.timedOut) {
      problems.push(
        `The import was still running after ${DEADLINE_MS / 1000} seconds.` +
          (hungOpen
            ? ` The save of order ${HUNG} never got an answer, and the import still waits for it.`
            : ""),
      );
    } else if (outcome.error) {
      problems.push(
        `The import stopped with ${describeError(outcome.error)}. ` +
          `${saved.size} of the ${GOOD.length} valid orders were saved, and nobody knows which ones are missing.`,
      );
    }

    if (peak > LIMIT || tooMany > 0) {
      problems.push(
        `The import sent more than ${LIMIT} saves at once. The orders service handles ${LIMIT} at a time, ` +
          `so it answered 429 Too Many Requests to ${count(tooMany, "save")}.`,
      );
    }

    const early = pageRequests.find(
      ({ page, received }) => page > 1 && ![...received].some((id) => pageOf(id) === page - 1),
    );
    if (early) {
      const before = pageRequests.filter(({ received }) => received.size === 0).length;
      problems.push(
        before === PAGES
          ? `The import loaded all ${PAGES} pages before it sent a single order to the orders service. ` +
              "With the partner's real 4,000 pages, every order sits in memory, and the first save waits for the last page."
          : `The import asked for page ${early.page} before it sent any order from page ${early.page - 1}. ` +
              "Load a page only when the orders before it are on their way.",
      );
    }

    if (!outcome.timedOut && !outcome.error) {
      const missing = GOOD.filter((id) => !saved.has(id));
      if (missing.length) {
        problems.push(
          `${count(missing.length, "valid order")} never reached the orders service, such as ${missing[0]}.`,
        );
      }

      const { imported, failed } = outcome.value ?? {};
      const failedIds = Array.isArray(failed) ? failed.map((item) => item?.id) : null;
      if (!failedIds) {
        problems.push("importOrders should return { imported, failed }, with failed as a list of { id, reason }.");
      } else {
        const unlisted = SHOULD_FAIL.filter((id) => !failedIds.includes(id));
        if (unlisted.length) {
          const reasons = unlisted.map((id) =>
            id === HUNG ? `${id} (its save never got an answer)` : `${id} (422 ${INVALID.get(id)})`,
          );
          problems.push(
            `The result doesn't list ${list(reasons)} as failed. ` +
              "Nobody gets to fix those orders by hand, because nobody knows they're missing.",
          );
        }
        const wrong = failedIds.filter((id) => saved.has(id));
        if (wrong.length) {
          problems.push(`The result lists order ${wrong[0]} as failed, but the orders service saved it.`);
        }
        if (imported !== saved.size) {
          problems.push(`The result says ${imported} orders were imported, and the orders service saved ${saved.size}.`);
        }
      }

      if (hungOpen) {
        problems.push(
          `The import finished, but the save of order ${HUNG} was still open on the orders service. ` +
            "The import stopped waiting for it, and the request kept running.",
        );
      }
    }

    const twice = [...sends].filter(([, times]) => times > 1);
    if (twice.length) {
      const [id, times] = twice[0];
      problems.push(
        `The import sent order ${id} to the orders service ${times} times. A 422 fails the same way every time, ` +
          "and a save that timed out may have gone through, so sending the POST again can save the order twice.",
      );
    }

    return problems;
  },
};
