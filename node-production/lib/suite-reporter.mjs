// A node:test reporter for lab 03's test: one JSON line per test that passes or fails.

export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (event.data.details?.type === "suite") continue;
    const error = event.data.details?.error;
    yield `${JSON.stringify({
      type: event.type === "test:pass" ? "pass" : "fail",
      name: event.data.name,
      error: error ? describe(error.cause ?? error) : undefined,
    })}\n`;
  }
}

function describe(error) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.split("\n").slice(0, 6).join(" ").replace(/\s+/g, " ").trim();
}
