// The shop's search box. The page calls search(query) on each input, and renders what the
// callbacks get. The test plays the page: it types, and records each call to onResults and
// onError.
//
// The search API:
//   GET {apiUrl}/search?q=laptop   -> { products: ["Laptop", "Laptop stand"] }
//
// createSearchBox returns:
//   search(query)  Starts a search. Returns a promise that settles when this search is over:
//                  its results or its error are on the page, or a newer search replaced it.
//   destroy()      The page calls it when the user leaves the search page.
//
// A search that takes longer than 1 second should give up and show an error.

const TIMEOUT_MS = 1000;

export function createSearchBox({ apiUrl, onResults, onError }) {
  let destroyed = false;

  async function search(query) {
    try {
      const products = await withTimeout(getProducts(apiUrl, query), TIMEOUT_MS);
      if (!destroyed) onResults(query, products);
    } catch (error) {
      if (!destroyed) onError(error);
    }
  }

  function destroy() {
    destroyed = true;
  }

  return { search, destroy };
}

async function getProducts(apiUrl, query) {
  const response = await fetch(`${apiUrl}/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`Search failed with ${response.status}`);
  const { products } = await response.json();
  return products;
}

function withTimeout(promise, ms) {
  const timeout = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`Search timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]);
}
