/**
 * FINDING LOCATION VERIFICATION (Valet Security guardrail 4): the
 * `sec_finding_report` route verifies a cited `file:line` against the persona
 * cell's cloned sandbox BEFORE the service records it.
 *
 * The route calls `engineHost.readSandboxFileMeta(actingSessionId, file)`. The
 * fail-open/closed split is the crux:
 *   - `{ exists: false }` → the file is confirmed absent → the finding is
 *     REFUSED 400 (the message names the file).
 *   - `{ exists: true, lines }` with a cited `line > lines` → REFUSED 400.
 *   - `{ exists: true, lines }` with an in-range (or no) line → ACCEPTED.
 *   - `null` (indeterminate: no ready sandbox, no clone, read error) → ACCEPTED
 *     (fail open) — a sandbox hiccup must NEVER block a real finding.
 *
 * The virtual sandbox never runs a real `git clone`, so a live read would find
 * no files. This suite stubs `engineHost.readSandboxFileMeta` per case and
 * asserts the route's branching. The read path itself is unit-tested against a
 * real in-memory sandbox in `host.security-file-meta.test.ts`.
 *
 * No ANTHROPIC_API_KEY and no model turn: the runner thread is paused; the
 * child is left dispatched (running) so its cell claim stays live for the
 * finding routes.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import {
  EVIDENCE,
  actingAs,
  buildPausedRunner,
  createSecuritySession,
  dispatchViaRoute,
  setPlanViaRoute,
  startViaRoute,
} from "./security-harness.js";
import type { SecurityReportFindingResponse } from "../wire/types.js";

/** One plain code-review cell — the persona child that reports findings. */
const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
].join("\n");

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** POST a finding as the child WITHOUT asserting the status — the caller
 * inspects it. */
async function reportRaw(
  api: TestApi,
  childSessionId: string,
  finding: { severity: string; title: string; file?: string; line?: number; body: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${childSessionId}/security/findings`, {
    method: "POST",
    headers: actingAs(childSessionId),
    body: JSON.stringify(finding),
  });
  return { status: res.status, body: await res.json() };
}

function errorOf(body: unknown): string | undefined {
  return typeof body === "object" && body !== null && "error" in body
    ? String((body as { error: unknown }).error)
    : undefined;
}

describe("api integration: finding location verification (guardrail 4)", () => {
  it(
    "refuses a missing file and an out-of-range line; accepts a real location and fails open on indeterminacy",
    async () => {
      api = await bootTestApi();
      const { db, engineHost } = api.providers;

      const { sessionId } = await createSecuritySession(api);
      const { threadId } = await buildPausedRunner(api, sessionId);
      await setPlanViaRoute(api, sessionId, PLAN);
      await startViaRoute(api, sessionId);

      const dispatched = await dispatchViaRoute(api, sessionId, threadId);
      const child = dispatched.cell.childSessionId!;
      expect(child).toBeTruthy();

      // Capture the original so each case restores it — the stub is per-branch.
      const original = engineHost.readSandboxFileMeta.bind(engineHost);

      // ── Case 1: confirmed-absent file → REFUSED 400, message names the file.
      engineHost.readSandboxFileMeta = async () => ({ exists: false, lines: 0 });
      const missing = await reportRaw(api, child, {
        severity: "high",
        title: "SQLi in a file that is not there",
        file: "src/nope.ts",
        line: 12,
        body: EVIDENCE,
      });
      expect(missing.status).toBe(400);
      expect(errorOf(missing.body)).toMatch(/does not exist/);
      expect(errorOf(missing.body)).toContain("src/nope.ts");

      // ── Case 2: file exists but the cited line is past the end → REFUSED 400.
      engineHost.readSandboxFileMeta = async () => ({ exists: true, lines: 40 });
      const pastEnd = await reportRaw(api, child, {
        severity: "high",
        title: "SQLi cited past the end of the file",
        file: "src/auth/login.ts",
        line: 999,
        body: EVIDENCE,
      });
      expect(pastEnd.status).toBe(400);
      expect(errorOf(pastEnd.body)).toMatch(/past the end/);
      expect(errorOf(pastEnd.body)).toContain("40 lines");

      // ── Case 3: file exists and the cited line is in range → ACCEPTED.
      engineHost.readSandboxFileMeta = async () => ({ exists: true, lines: 40 });
      const inRange = await reportRaw(api, child, {
        severity: "high",
        title: "SQLi at a real line",
        file: "src/auth/login.ts",
        line: 12,
        body: EVIDENCE,
      });
      expect(inRange.status).toBe(200);
      const accepted = inRange.body as SecurityReportFindingResponse;
      expect(accepted.finding.file).toBe("src/auth/login.ts");
      expect(accepted.finding.line).toBe(12);

      // ── Case 4: indeterminate (null) → ACCEPTED (fail open). A sandbox hiccup
      // must never block a real finding — this is the mandatory asymmetry.
      engineHost.readSandboxFileMeta = async () => null;
      const failOpen = await reportRaw(api, child, {
        severity: "medium",
        title: "Finding kept despite an unready sandbox",
        file: "src/whatever.ts",
        line: 5000,
        body: EVIDENCE,
      });
      expect(failOpen.status).toBe(200);

      // ── Case 5: a repo-wide finding with NO file skips the check entirely —
      // even while the stub would report absent, a fileless finding is accepted.
      engineHost.readSandboxFileMeta = async () => ({ exists: false, lines: 0 });
      const repoWide = await reportRaw(api, child, {
        severity: "low",
        title: "Repo-wide: no dependency pinning",
        body: EVIDENCE,
      });
      expect(repoWide.status).toBe(200);

      // Restore so cleanup does not run against a stubbed method.
      engineHost.readSandboxFileMeta = original;

      // Tidy: settle the child so cleanup does not race a live turn.
      await engineHost.liveSession(child)?.abort();
      void db;
    },
    60_000,
  );
});
