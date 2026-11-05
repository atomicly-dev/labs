// Plays the search page against a real search API on a random port. The API answers each query
// when the test says so, so the order of the answers is the same on every run:
//
// 1. The user types "l", "la", "lap", then "laptop". The API answers "laptop" right away, and the
//    3 older searches only after that, as when a short query matches more products.
// 2. The user searches for "printer ink", and the API never answers.
// 3. The user searches for "monitor", then leaves the page before the answer.
//
// The test records what the page shows, which requests the server answered, and which ones the
// client closed before an answer.

import { count, describeError, list, loadModule, sendJson, within } from "../lib/helpers.mjs";

const CATALOG = {
  l: ["Lamp", "Laptop", "Lap desk", "Lens cap"],
  la: ["Lamp", "Laptop", "Lap desk"],
  lap: ["Lap desk", "Laptop", "Laptop stand"],
  laptop: ["Laptop", "Laptop stand"],
  monitor: ["Monitor", "Monitor arm"],
};
const TYPED = ["l", "la", "lap"];
const FINAL = "laptop";
const HUNG = "printer ink";
const LEAVE = "monitor";

export default {
  file: "search.mjs",
  lesson: "https://atomicly.dev/lessons/js-cancellation",

  async run({ file, serve, events }) {
    const loaded = await loadModule(file, ["createSearchBox"]);
    if (loaded.problems) return loaded.problems;

    const api = searchApi();
    const apiUrl = await serve(api.handle);

    const page = []; // what the page showed, in order: { query, products } or { error }
    let left = false;
    const afterLeaving = [];
    const box = loaded.app.createSearchBox({
      apiUrl,
      onResults: (query, products) => (left ? afterLeaving : page).push({ query, products }),
      onError: (error) => (left ? afterLeaving : page).push({ error }),
    });
    if (typeof box?.search !== "function" || typeof box?.destroy !== "function") {
      return ["createSearchBox should return { search, destroy }."];
    }

    const problems = [];
    const timersBefore = timerCount();

    // 1. The user types. Each search starts when the API has the one before it.
    const typing = [];
    for (const query of TYPED) {
      typing.push(Promise.resolve(box.search(query)));
      if ((await within(api.arrived(query), 2000)).timedOut) {
        return [`search("${query}") didn't send a request to the search API.`];
      }
    }
    typing.push(Promise.resolve(box.search(FINAL)));
    const final = await within(typing.at(-1), 3000);
    const leftoverTimers = timerCount() - timersBefore;

    // The older searches' requests should be closed by now. The server sees a close a moment
    // after the client aborts, so give it up to 300 ms, well before a search's 1 second limit.
    await within(Promise.all(TYPED.map((query) => api.closed(query))), 300);
    const keptOpen = TYPED.filter((query) => api.state(query) === "open");
    api.release(...TYPED);
    await within(Promise.all(typing), 3000);

    const finalAt = page.findIndex((item) => item.query === FINAL);
    const after = page.slice(finalAt + 1).findLast((item) => !(item.error?.name === "AbortError"));
    if (final.timedOut) {
      problems.push(`The search for "${FINAL}" never finished, though the API answered it right away.`);
    } else if (finalAt === -1) {
      problems.push(`The page never showed the results for "${FINAL}", though the API answered.`);
    } else if (after?.query) {
      problems.push(
        `The user typed "${FINAL}", and the page ends up showing the results for "${after.query}": ` +
          `${list(after.products)}. The older search answered last, and its results replaced the newer ones.`,
      );
    } else if (after) {
      problems.push(
        `The page showed the results for "${FINAL}", then an error from an older search replaced them: ` +
          `${describeError(after.error)}.`,
      );
    }

    if (keptOpen.length) {
      problems.push(
        `The requests for ${list(keptOpen.map((query) => `"${query}"`))} stayed open on the server after ` +
          "the user typed the next letter. The server ran each search to the end, for results nobody sees.",
      );
    }

    if (leftoverTimers > 0) {
      problems.push(
        `When the results for "${FINAL}" showed, ${count(leftoverTimers, "timer was", "timers were")} still ` +
          "waiting to fire, one for each search. Each one keeps its search in memory for a full second, " +
          "and a fast typist makes one per key.",
      );
    }

    // 2. The API never answers. After 1 second, the search should give up and show an error.
    const beforeHung = page.length;
    const hung = Promise.resolve(box.search(HUNG));
    await within(api.arrived(HUNG), 2000);
    const hungOutcome = await within(hung, 4000);
    if (hungOutcome.timedOut) {
      problems.push(
        `The search API never answered "${HUNG}", and the search was still waiting after 4 seconds. ` +
          "The user sees a spinner forever. A search should give up after 1 second and show an error.",
      );
    } else {
      const hungErrors = page.slice(beforeHung).filter((item) => item.error);
      if (!hungErrors.length) {
        problems.push(
          `The search for "${HUNG}" gave up, but the page showed no error. ` +
            "The user waits for results that never come. A timeout isn't a cancel: show it.",
        );
      }
      await within(api.closed(HUNG), 1000);
      if (api.state(HUNG) === "open") {
        problems.push(
          `The search for "${HUNG}" gave up after its time limit, but its request stayed open on the server. ` +
            "Each slow search leaves a request running.",
        );
      }
    }

    // 3. The user searches, then leaves the page before the answer.
    const leaving = Promise.resolve(box.search(LEAVE));
    await within(api.arrived(LEAVE), 2000);
    left = true;
    box.destroy();
    await within(api.closed(LEAVE), 1000);
    const leaveOpen = api.state(LEAVE) === "open";
    api.release(LEAVE);
    await within(leaving, 3000);
    if (leaveOpen) {
      problems.push(
        `The user left the search page, and the request for "${LEAVE}" stayed open on the server. ` +
          "destroy() should stop the search, not only hide its results.",
      );
    }
    const late = afterLeaving.find((item) => !(item.error?.name === "AbortError"));
    if (late) {
      problems.push(
        `After the user left the search page, the page still got ${late.query ? `the results for "${late.query}"` : `an error, ${describeError(late.error)}`}.`,
      );
    }

    // An abort means a newer search, or destroy(), stopped this one on purpose.
    const aborts = [...page, ...afterLeaving].filter((item) => item.error?.name === "AbortError");
    if (aborts.length) {
      problems.push(
        `The page showed ${count(aborts.length, "error")}, one for each search that stopped on purpose: ` +
          `${describeError(aborts[0].error)}. An AbortError means a newer search, or leaving the page, ` +
          "stopped the search, so there's nothing to show.",
      );
    }
    const unhandledAborts = events.unhandled.filter((reason) => reason?.name === "AbortError");
    if (unhandledAborts.length) {
      events.unhandled = events.unhandled.filter((reason) => reason?.name !== "AbortError");
      problems.push(
        `${count(unhandledAborts.length, "aborted search", "aborted searches")} rejected with no handler: ` +
          `${describeError(unhandledAborts[0])}. In Node, that stops the process, and in a browser it fills the error tracker.`,
      );
    }

    return problems;
  },
};

function timerCount() {
  return process.getActiveResourcesInfo().filter((type) => type === "Timeout").length;
}

// The search API. It holds each query's request until the test releases it, except "laptop",
// which it answers right away, and "printer ink", which it never answers. For each query, it
// records whether the request is open, answered, or closed by the client before an answer.
function searchApi() {
  const requests = new Map(); // query -> { state, res, waiters }
  const waiting = { arrived: new Map(), closed: new Map() };

  const notify = (kind, query) => {
    for (const resolve of waiting[kind].get(query) ?? []) resolve();
    waiting[kind].delete(query);
  };
  const wait = (kind, query, done) =>
    done ? Promise.resolve() : new Promise((resolve) => waiting[kind].set(query, [...(waiting[kind].get(query) ?? []), resolve]));
  const answer = (query) => {
    const request = requests.get(query);
    if (request?.state !== "open") return;
    sendJson(request.res, 200, { products: CATALOG[query] ?? [] });
  };

  return {
    handle(req, res) {
      const url = new URL(req.url, "http://api");
      if (url.pathname !== "/search") return sendJson(res, 404, { error: "not found" });
      const query = url.searchParams.get("q") ?? "";
      const request = { state: "open", res };
      requests.set(query, request);
      res.on("close", () => {
        request.state = res.writableFinished ? "answered" : "closed";
        notify("closed", query);
      });
      notify("arrived", query);
      if (query === FINAL) setTimeout(() => answer(query), 10);
    },
    arrived: (query) => wait("arrived", query, requests.has(query)),
    closed: (query) => wait("closed", query, requests.has(query) && requests.get(query).state !== "open"),
    state: (query) => requests.get(query)?.state,
    release: (...queries) => queries.forEach(answer),
  };
}
