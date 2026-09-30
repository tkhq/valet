import { describe, expect, it } from "vitest";
import { livePollInterval } from "./live-poll";

interface Payload {
  rows: { done: boolean }[];
}

const anyRunning = (data: Payload) => data.rows.some((row) => !row.done);

describe("livePollInterval", () => {
  it("does not schedule a poll before the first response lands", () => {
    expect(livePollInterval<Payload>(undefined, anyRunning, 1000)).toBe(false);
  });

  it("polls at the given period while a row is still running", () => {
    expect(livePollInterval({ rows: [{ done: true }, { done: false }] }, anyRunning, 1000)).toBe(1000);
  });

  it("stops entirely once nothing is running", () => {
    expect(livePollInterval({ rows: [{ done: true }] }, anyRunning, 1000)).toBe(false);
  });

  it("treats an empty list as nothing to poll for", () => {
    expect(livePollInterval({ rows: [] }, anyRunning, 1000)).toBe(false);
  });
});
