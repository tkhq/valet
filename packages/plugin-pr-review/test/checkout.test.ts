import { describe, expect, it } from "vitest";
import { assertCheckout, CHECKOUT_COMMAND, checkoutSection, type RepoRunner } from "../src/index.js";

const runner = (exitCode: number, stdout: string, stderr = ""): RepoRunner => ({
  run: async (command) => {
    expect(command).toBe(CHECKOUT_COMMAND);
    return { exitCode, stdout, stderr, truncated: false, timedOut: false };
  },
});

describe("assertCheckout", () => {
  const head = "a".repeat(40);

  it("returns the checkout path when the checkout is at the head", async () => {
    await expect(assertCheckout(runner(0, `/workspace/shop\n${head}\n`), head)).resolves.toBe("/workspace/shop");
  });

  it("names the git error and the fix when there is no checkout", async () => {
    await expect(assertCheckout(runner(128, "", "fatal: not a git repository\nmore"), head))
      .rejects.toThrow("The review sandbox has no git checkout of the repository (fatal: not a git repository). Check that the GitHub App can clone this repository, then retry the delivery.");
  });

  it("refuses a checkout at another commit", async () => {
    await expect(assertCheckout(runner(0, `/workspace/shop\n${"b".repeat(40)}\n`), head)).rejects.toThrow("The review sandbox is at bbbbbbb, not aaaaaaa.");
  });

  it("refuses output without an absolute checkout path", async () => {
    await expect(assertCheckout(runner(0, `shop\n${head}\n`), head)).rejects.toThrow("The review sandbox reported no checkout path (shop).");
  });
});

describe("checkoutSection", () => {
  it("names the path and quotes it for the shell", () => {
    const section = checkoutSection("/workspace/it's");
    expect(section).toContain("checked out at `/workspace/it's`");
    expect(section).toContain("`cd '/workspace/it'\\''s' && `");
  });
});
