import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Wakeups seam injection (spec 2026-10-08): every session builder in
 * host.ts must inject the wakeups seam alongside extractDocument, or the
 * engine tools (bash background, watch, wake_at, ...) silently degrade to
 * WAKEUPS_UNAVAILABLE for that builder's sessions. A grep test catches a
 * new or edited builder that forgets the spread, without re-implementing
 * each builder's control flow here.
 */
describe("every session builder injects the wakeups seam", () => {
  it("has one wakeupsOptions spread per extractDocument site", async () => {
    const src = await readFile(new URL("./host.ts", import.meta.url), "utf8");
    const builders = src.match(/extractDocument: extractDocumentText/g)?.length ?? 0;
    const seams = src.match(/\.\.\.this\.wakeupsOptions\(/g)?.length ?? 0;
    expect(builders).toBeGreaterThan(0);
    expect(seams).toBe(builders);
  });

  /**
   * Same host-multi-builder trap for the lease seam (spec INV-8, Task 19):
   * a builder that gets `wakeups` but not `isLeased` lets its attachment
   * replace a leased sandbox's pod. One `leaseOptions` spread per
   * `wakeupsOptions` spread keeps the two seams wired together.
   */
  it("has one leaseOptions spread per wakeupsOptions spread", async () => {
    const src = await readFile(new URL("./host.ts", import.meta.url), "utf8");
    const seams = src.match(/\.\.\.this\.wakeupsOptions\(/g)?.length ?? 0;
    const leases = src.match(/\.\.\.this\.leaseOptions\(/g)?.length ?? 0;
    expect(seams).toBeGreaterThan(0);
    expect(leases).toBe(seams);
  });
});
