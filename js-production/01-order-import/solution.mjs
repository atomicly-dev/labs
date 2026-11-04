// The nightly order import. See importer.mjs for the two services and what importOrders returns.

const LIMIT = 5; // the orders service handles 5 requests at a time
const TIMEOUT_MS = 1000; // the longest the import waits for one request

export async function importOrders({ partnerUrl, storeUrl }) {
  const orders = listOrders(partnerUrl);
  let imported = 0;
  const failed = [];

  // A pool of 5 workers. They share one async generator: each `for await` asks it for the next
  // order, and it loads the next page only when a worker asks after the current page runs out.
  // So at most one page is in memory, and at most 5 saves run at once.
  async function worker() {
    for await (const order of orders) {
      try {
        await saveOrder(storeUrl, order);
        imported++;
      } catch (error) {
        // One bad order doesn't stop the import. It goes on the list for someone to fix.
        failed.push({ id: order.id, reason: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: LIMIT }, () => worker()));

  return { imported, failed };
}

async function* listOrders(partnerUrl) {
  let cursor = null;
  do {
    const url = cursor ? `${partnerUrl}/orders?cursor=${cursor}` : `${partnerUrl}/orders`;
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The partner's API answered ${response.status}`);
    const page = await response.json();
    for (const order of page.orders) {
      yield order;
    }
    cursor = page.nextCursor;
  } while (cursor);
}

// No retries. A 422 fails the same way every time. And a save that timed out may have reached
// the orders service, so sending the POST again could save the order twice.
async function saveOrder(storeUrl, order) {
  const response = await fetch(`${storeUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    const { error } = await response.json();
    throw new Error(`${response.status} ${error}`);
  }
}
