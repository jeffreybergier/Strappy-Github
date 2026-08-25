import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.js";

test("createLogger throws on an empty scope", () => {
  assert.throws(() => createLogger(""), /scope must be a non-empty string/);
  assert.throws(() => createLogger("   "), /scope must be a non-empty string/);
});

test("createLogger returns debug/info/warn/error functions", () => {
  const log = createLogger("Test");
  assert.equal(typeof log.debug, "function");
  assert.equal(typeof log.info, "function");
  assert.equal(typeof log.warn, "function");
  assert.equal(typeof log.error, "function");
});

test("lines lead with an ISO timestamp; warn adds [WARNING] before the scope", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const info = t.mock.method(console, "info", () => {});
  const log = createLogger("Test");
  log.warn("method", "be careful");
  log.info("method", "all good");
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
  assert.match(String(warn.mock.calls[0]?.arguments[0]), stamp);
  assert.match(String(info.mock.calls[0]?.arguments[0]), stamp);
  assert.ok(String(warn.mock.calls[0]?.arguments[0]).endsWith("[WARNING] [Test.method] be careful"));
  assert.ok(String(info.mock.calls[0]?.arguments[0]).endsWith("[Test.method] all good"));
});

test("debug is silent at info and prints at debug", (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  createLogger("Test", "info").debug("method", "hidden");
  assert.equal(debug.mock.callCount(), 0);
  createLogger("Test", "debug").debug("method", "shown");
  assert.equal(debug.mock.callCount(), 1);
});

test("warn level silences info but keeps warn and error", (t) => {
  const info = t.mock.method(console, "info", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  const error = t.mock.method(console, "error", () => {});
  const log = createLogger("Test", "warn");
  log.info("method", "quiet");
  log.warn("method", "loud");
  log.error("method", "loud");
  assert.equal(info.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(error.mock.callCount(), 1);
});
