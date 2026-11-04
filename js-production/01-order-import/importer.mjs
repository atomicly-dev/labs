// The nightly order import. It copies every order from a partner's API into the shop's orders
// service. The test calls importOrders with the two services' URLs.
//
// The partner's API returns orders a page at a time:
//   GET {partnerUrl}/orders             -> { orders: [...], nextCursor: "p2" }
//   GET {partnerUrl}/orders?cursor=p2   -> { orders: [...], nextCursor: "p3" }
//   ...and on the last page, nextCursor is null.
//
// The orders service saves one order per request:
//   POST {storeUrl}/orders, with the order as JSON
//   -> 201 when it saved the order, or 422 with { error } when the order is invalid.
//   It handles 5 requests at a time, and answers 429 Too Many Requests to any more.
//
// The import should never wait more than 1 second for one request.
//
// importOrders returns { imported, failed }: the number of orders the service saved, and for
// each order it didn't save, { id, reason }, so someone can fix that order by hand.

export async function importOrders({ partnerUrl, storeUrl }) {
  const orders = await getAllOrders(partnerUrl);
  await Promise.all(orders.map((order) => saveOrder(storeUrl, order)));
  return { imported: orders.length, failed: [] };
}

async function getAllOrders(partnerUrl) {
  const orders = [];
  let cursor = null;
  do {
    const url = cursor ? `${partnerUrl}/orders?cursor=${cursor}` : `${partnerUrl}/orders`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The partner's API answered ${response.status}`);
    const page = await response.json();
    orders.push(...page.orders);
    cursor = page.nextCursor;
  } while (cursor);
  return orders;
}

async function saveOrder(storeUrl, order) {
  const response = await fetch(`${storeUrl}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order),
  });
  if (!response.ok) {
    const { error } = await response.json();
    throw new Error(`${response.status} ${error}`);
  }
}
