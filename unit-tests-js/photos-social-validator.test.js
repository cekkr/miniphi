import test from "node:test";
import assert from "node:assert/strict";

import { explainStderr } from "../scripts/photos-social/validator.js";

/**
 * The sample validator is instrumentation, but the sentence it hands back to
 * the agent *is* the agent's only view of a boot failure. Reporting the tail of
 * stderr — the obvious implementation — reports the bottom of a stack trace and
 * cuts the cause off entirely.
 */
test("a boot failure is explained by its cause, not by the end of its stack trace", () => {
  const stderr = [
    "node:internal/modules/esm/resolve:265",
    "    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
    "          ^",
    "",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'hono' imported from /Users/x/server/index.js",
    "    at packageResolve (node:internal/modules/esm/resolve:265:9)",
    "    at moduleResolve (node:internal/modules/esm/resolve:933:18)",
  ].join("\n");

  const explained = explainStderr(stderr);
  assert.match(explained, /Cannot find package 'hono'/);
  // The tail is what the old implementation returned, and it says nothing.
  assert.doesNotMatch(explained, /^\s*at moduleResolve/);
});

test("a syntax error at boot is reported by its message", () => {
  const stderr = [
    "/Users/x/server/index.js:12",
    "const app = new Hono(",
    "                    ^",
    "",
    "SyntaxError: missing ) after argument list",
    "    at compileSourceTextModule (node:internal/modules/esm/utils:340:16)",
  ].join("\n");
  assert.match(explainStderr(stderr), /SyntaxError: missing \) after argument list/);
});

test("stderr with no recognizable error still yields the opening lines", () => {
  assert.match(explainStderr("warn: something odd\nstill starting\n"), /warn: something odd/);
  assert.equal(explainStderr(""), "");
  assert.equal(explainStderr(null), "");
});

test("the explanation is bounded", () => {
  assert.ok(explainStderr(`Error: ${"x".repeat(5000)}`).length <= 700);
});

test("Node's own source lines never masquerade as the diagnosis", () => {
  // Both real traces seen live. Each shows the *source* that raised the error,
  // and that source line contains the error's name — so any keyword search
  // returns the code instead of the message it is about to produce.
  const moduleNotFound = [
    "node:internal/modules/esm/resolve:265",
    "    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
    "          ^",
    "",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'hono' imported from /Users/x/server/index.js",
    "    at packageResolve (node:internal/modules/esm/resolve:265:9)",
  ].join("\n");
  const notExported = [
    "node:internal/modules/esm/resolve:314",
    "      return new ERR_PACKAGE_PATH_NOT_EXPORTED(",
    "             ^",
    "",
    'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in /Users/x/server/node_modules/hono/package.json',
    "    at exportsNotFound (node:internal/modules/esm/resolve:314:10)",
  ].join("\n");

  const first = explainStderr(moduleNotFound);
  assert.match(first, /Cannot find package 'hono'/);
  assert.doesNotMatch(first, /throw new/);

  const second = explainStderr(notExported);
  assert.match(second, /No "exports" main defined/);
  assert.doesNotMatch(second, /return new/);
});
