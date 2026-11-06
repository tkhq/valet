import { isRedirect } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { leaveOverview } from "./overview";

it("sends an old /overview link to Home", () => {
  let thrown: unknown;
  try {
    leaveOverview();
  } catch (error) {
    thrown = error;
  }
  expect(isRedirect(thrown)).toBe(true);
  expect(isRedirect(thrown) && thrown.options.to).toBe("/");
});
