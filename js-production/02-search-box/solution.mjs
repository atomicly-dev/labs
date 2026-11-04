// The shop's search box. See search.mjs for what the page and the test expect.

const TIMEOUT_MS = 1000;

export function createSearchBox({ apiUrl, onResults, onError }) {
  // The controller of the newest search. A new search, or destroy(), aborts it.
  let controller = new AbortController();

  async function search(query) {
    controller.abort();
    controller = new AbortController();
    // The request stops on whichever comes first: a newer search, destroy(), or 1 second.
    // Nothing has to clear AbortSignal.timeout's timer: it doesn't keep the process running.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      const products = await getProducts(apiUrl, query, signal);
      onResults(query, products);
    } catch (error) {
      // A newer search or destroy() stopped this one on purpose. There's nothing to show.
      if (error.name === "AbortError") return;
      // A TimeoutError, or a real failure, is worth showing.
      onError(error);
    }
  }

  function destroy() {
    controller.abort();
  }

  return { search, destroy };
}

async function getProducts(apiUrl, query, signal) {
  const response = await fetch(`${apiUrl}/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error(`Search failed with ${response.status}`);
  const { products } = await response.json();
  return products;
}
