// The labs use AbortSignal.any, module.registerHooks, and other APIs that need Node.js 24 or later.

export function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    console.error(`These labs need Node.js 24 or later, and this is Node.js ${process.versions.node}.`);
    process.exit(2);
  }
}
