// The two services on the checkout path. You don't need to change this file: both call their
// dependency through a retrier from retry.mjs.
//
//   storefront API  ->  orders service  ->  inventory service
//   (2 s a try)         (250 ms a try)      (behind Toxiproxy)
//
// Before the checkout page offers "Buy now", the storefront asks the orders service whether a
// product can ship. The orders service asks the inventory service for the stock. Each service
// runs as its own process in production, with its own retrier.

import http from "node:http";

/**
 * Starts the orders service on a random port. GET /can-ship/:productId answers
 * 200 { canShip } or 503 { error }.
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function startOrdersService({ inventoryUrl, retrier }) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const match = /^\/can-ship\/(\d+)$/.exec(req.url ?? "");
    if (!match) return send(404, { error: "Not found" });
    try {
      const stock = await retrier.call(
        async (signal) => {
          const res = await fetch(`${inventoryUrl}/stock/${match[1]}`, { signal });
          if (!res.ok) throw new Error(`The inventory service answered ${res.status}`);
          return res.json();
        },
        { timeoutMs: 250 },
      );
      send(200, { canShip: stock.inStock > 0 });
    } catch (error) {
      send(503, { error: `Can't check the stock: ${error.message}` });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * The storefront API's call to the orders service. canShip resolves with true or false, and
 * rejects when the orders service can't answer.
 */
export function createStorefront({ ordersUrl, retrier }) {
  return {
    async canShip(productId) {
      const body = await retrier.call(
        async (signal) => {
          const res = await fetch(`${ordersUrl}/can-ship/${productId}`, { signal });
          if (!res.ok) throw new Error(`The orders service answered ${res.status}`);
          return res.json();
        },
        { timeoutMs: 2000 },
      );
      return body.canShip;
    },
  };
}
