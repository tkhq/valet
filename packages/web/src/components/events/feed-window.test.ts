/**
 * The scoped feed's window is written down twice: `OWNER_FEED_WINDOW_MS`
 * bounds the query in `packages/api/src/routes/events.ts`, and
 * `WORKSPACE_WINDOW_DAYS` is the number this page prints — in the scoped
 * empty state, and under a scoped list that has rows. Each file tells the
 * reader to change the other, and nothing made them. A drift is silent and
 * it lies to the reader: the page names a window the route does not keep.
 *
 * The route is read as text because it is a server module, and importing it
 * into a browser-side suite would pull the whole api package in for one
 * number.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKSPACE_WINDOW_DAYS } from "./feed";

const ROUTE = fileURLToPath(new URL("../../../../api/src/routes/events.ts", import.meta.url));

/** Matches the declaration exactly as it is written. A change to the SHAPE
 * of the expression fails here too, which is correct: the pair has to be
 * re-read whenever either side moves. */
const DECLARATION = /^const OWNER_FEED_WINDOW_MS = (\d+) \* 24 \* 60 \* 60 \* 1000;$/m;

describe("the scoped feed window", () => {
  it("prints the number of days the route bounds the query to", () => {
    const match = DECLARATION.exec(readFileSync(ROUTE, "utf8"));
    expect(match, `OWNER_FEED_WINDOW_MS is not declared as N days in ${ROUTE}`).not.toBeNull();
    expect(Number(match?.[1])).toBe(WORKSPACE_WINDOW_DAYS);
  });
});
