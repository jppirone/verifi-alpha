// Loader for the private fixtures (prompt EK, October 28, 2026). tools/resume/fixtures-private/ is git-ignored: it holds stored test documents of a real person, so it is
// not in the repository and a fresh clone does not have it. A test that needs one of those files calls loadPrivate(name); it gets the module, or null when the file is not
// there, and the test then skips its private checks with the message below instead of failing.
import fs from "node:fs";

export const SKIP_MESSAGE = "private fixture not present, check skipped";

export async function loadPrivate(name) {
  const url = new URL("./fixtures-private/" + name, import.meta.url);
  if (!fs.existsSync(url)) return null;
  return await import(url.href);
}

// Wraps one test so it is skipped (with the message) when its private fixture is missing.
export function skipUnless(fixture, name, fn, log = console.log) {
  return () => {
    if (!fixture) { log("  skip " + name.slice(0, 80) + ": " + SKIP_MESSAGE); return; }
    return fn();
  };
}
