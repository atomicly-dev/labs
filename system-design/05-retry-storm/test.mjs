// The test starts the orders service and the storefront from services.mjs, each with its own
// retrier from your retry.mjs, as two processes would have. The orders service calls the real
// inventory service through Toxiproxy. The inventory service counts every call it gets.
//
// 1. A normal day: 10 checkouts, one after another. Each makes exactly 1 inventory call.
// 2. A blip: the inventory service answers 503 once. The next checkout still succeeds.
// 3. An outage: Toxiproxy delays every inventory answer by 3 seconds, so every call times out.
//    30 checkouts arrive, 10 at a time. They should fail, and make at most 45 inventory calls in
//    all, 1.5 per checkout.
// 4. Recovery: Toxiproxy stops the delay. Within 10 seconds, checkouts should succeed again.

import { count, fetchJson, sleep, within } from "../lib/helpers.mjs";
import { INVENTORY_ADMIN_URL, INVENTORY_URL, TOXIPROXY_URL } from "../lib/urls.mjs";
import { createStorefront, startOrdersService } from "./services.mjs";

const OUTAGE_CHECKOUTS = 30;
const AT_ONCE = 10;
const MAX_CALLS_PER_CHECKOUT = 1.5;

export default {
  file: "retry.mjs",
  lesson: "https://atomicly.dev/lessons/fetch-api-calls",

  async run(ctx) {
    // The same file, imported twice, the way two processes would load it.
    const load = async (name) => {
      try {
        return await import(`${ctx.file.href}?service=${name}`);
      } catch (error) {
        return { error };
      }
    };
    const forOrders = await load("orders");
    const forStorefront = await load("storefront");
    if (forOrders.error) return [`${ctx.fileName} doesn't load: ${forOrders.error.message}`];
    if (typeof forOrders.createRetrier !== "function") return [`${ctx.fileName} doesn't export a function called createRetrier.`];

    const toxiproxy = (path, init) => fetchJson(`${TOXIPROXY_URL}${path}`, init, "Toxiproxy");
    const inventory = (path, init) => fetchJson(`${INVENTORY_ADMIN_URL}${path}`, init, "the inventory service");
    await toxiproxy("/reset", { method: "POST" });
    ctx.defer(() => toxiproxy("/reset", { method: "POST" }));
    const calls = async () => {
      await sleep(200); // calls that are still on their way
      return (await inventory("/stats")).body.calls;
    };

    const orders = await startOrdersService({ inventoryUrl: INVENTORY_URL, retrier: forOrders.createRetrier() });
    ctx.defer(orders.close);
    const storefront = createStorefront({ ordersUrl: orders.url, retrier: forStorefront.createRetrier() });
    const checkout = () => within(storefront.canShip(3), 10_000);
    const problems = [];

    // 1. A normal day.
    await inventory("/reset", { method: "POST" });
    for (let i = 0; i < 10; i++) {
      const outcome = await checkout();
      if (outcome.value !== true) {
        return [`On a normal day, a checkout should learn that product 3 can ship, and got ${describe(outcome)}.`];
      }
    }
    const normalCalls = await calls();
    if (normalCalls !== 10) problems.push(`On a normal day, 10 checkouts made ${count(normalCalls, "inventory call")}, and they should make 10.`);

    // 2. A blip.
    await inventory("/fail-next?count=1", { method: "POST" });
    const blip = await checkout();
    if (blip.value !== true) {
      problems.push(`The inventory service answered 503 once. The checkout should retry and succeed, and got ${describe(blip)}.`);
    }

    // 3. An outage.
    await toxiproxy("/proxies/inventory/toxics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "slow", type: "latency", stream: "downstream", attributes: { latency: 3000 } }),
    });
    await inventory("/reset", { method: "POST" });
    const outcomes = [];
    for (let wave = 0; wave < OUTAGE_CHECKOUTS / AT_ONCE; wave++) {
      outcomes.push(...(await Promise.all(Array.from({ length: AT_ONCE }, checkout))));
    }
    const outageCalls = await calls();
    const hung = outcomes.filter((o) => o.timedOut).length;
    const succeeded = outcomes.filter((o) => o.value === true).length;
    if (hung) problems.push(`During the outage, ${count(hung, "checkout")} got no answer within 10 seconds.`);
    if (succeeded) problems.push(`During the outage, ${count(succeeded, "checkout")} succeeded, though the inventory service never answered in time.`);
    if (outageCalls > OUTAGE_CHECKOUTS * MAX_CALLS_PER_CHECKOUT) {
      problems.push(
        `During the outage, ${OUTAGE_CHECKOUTS} checkouts made ${outageCalls} calls to the inventory service, ` +
          `${round(outageCalls / OUTAGE_CHECKOUTS)} per checkout. They should make at most ${OUTAGE_CHECKOUTS * MAX_CALLS_PER_CHECKOUT}. ` +
          "The service was already too slow, and the retries sent it more work.",
      );
    }

    // 4. Recovery.
    await toxiproxy("/proxies/inventory/toxics/slow", { method: "DELETE" });
    const deadline = Date.now() + 10_000;
    let recovered = false;
    while (Date.now() < deadline) {
      if ((await checkout()).value === true) {
        recovered = true;
        break;
      }
      await sleep(250);
    }
    if (!recovered) {
      problems.push("The inventory service recovered, and 10 seconds later, checkouts still failed. They should succeed again once it answers.");
    }
    return problems;
  },
};

function describe(outcome) {
  if (outcome.timedOut) return "no answer within 10 seconds";
  if (outcome.error) return `an error: ${outcome.error.message}`;
  return JSON.stringify(outcome.value);
}

function round(n) {
  return Math.round(n * 10) / 10;
}
