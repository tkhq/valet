import { expect, it } from "vitest";
import { parseRetainedBrowserAudit } from "../src/browser-audit.js";
const entry = {
  invocationId: "call",
  cellId: "cell",
  operationId: "op",
  sessionId: "session",
  threadId: "thread",
  actorId: "actor",
  runtimeId: "runtime",
  method: "locator.click",
  hash: "hash",
  status: "in_flight",
};
it("rejects an incomplete retained audit export", () => {
  expect(() =>
    parseRetainedBrowserAudit({ entries: [entry], total: 2 }, "session"),
  ).toThrow(/invalid/i);
});
it("rejects an audit from another session or an invalid operation", () => {
  expect(() =>
    parseRetainedBrowserAudit({ entries: [entry], total: 1 }, "other"),
  ).toThrow(/owner/i);
  expect(() =>
    parseRetainedBrowserAudit(
      { entries: [{ ...entry, status: "unknown" }], total: 1 },
      "session",
    ),
  ).toThrow(/invalid/i);
  expect(() =>
    parseRetainedBrowserAudit({ entries: [entry], total: 0 }, "session"),
  ).toThrow(/invalid/i);
});
