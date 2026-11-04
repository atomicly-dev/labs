// Small helpers that the labs' tests share.

/**
 * Imports the module you edit and checks its exports.
 * Returns { app } or { problems } when it doesn't load.
 */
export async function loadModule(file, exports) {
  let app;
  try {
    app = await import(file.href);
  } catch (error) {
    return { problems: [`${fileName(file)} doesn't load: ${error.message}`] };
  }
  const missing = exports.filter((name) => typeof app[name] !== "function");
  if (missing.length) {
    return {
      problems: missing.map((name) => `${fileName(file)} doesn't export a function called ${name}.`),
    };
  }
  return { app };
}

export function fileName(url) {
  return url.pathname.split("/").at(-1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Settles with the promise's outcome, or with { timedOut: true } after ms. It clears its timer,
 * so it leaves nothing behind.
 * @returns {Promise<{ value?: unknown, error?: any, timedOut?: boolean }>}
 */
export async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error as one line: its name and its message. */
export function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** "1 order", "3 orders". */
export function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** A list in a sentence: "a", "a and b", "a, b, and c". */
export function list(items) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** Reads a request's body as JSON. */
export async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

/** Sends a JSON response. */
export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
