/**
 * Sandbox-reconciliation plan, Task 12: hourly token-rotation sweep.
 *
 * Uses fake timers (`vi.useFakeTimers`) so the interval fires on demand.
 * Uses a fake provider recording `updateCreds` calls.
 * Uses a real PGlite db so `mintSandboxToken` actually inserts rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { VirtualSandbox } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { sandboxTokens } from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";
import { runRotateSweep, startRotateSweep, type RotateHost } from "./rotate-sweep.js";

// ── Fake provider ───────────────────────────────────────────────────────────

interface UpdateCredsCall {
  sandboxId: string;
  files: Record<string, string>;
}

class FakeCredsMountProvider implements SandboxProvider {
  readonly backend = "fake-creds";
  readonly updateCredsCalls: UpdateCredsCall[] = [];
  /** Set to true to make `updateCreds` reject for the next call. */
  rejectNextUpdate: boolean = false;
  private _credsMount: boolean;

  constructor(credsMount = true) {
    this._credsMount = credsMount;
  }

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      credsMount: this._credsMount,
    };
  }

  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    return new VirtualSandbox("fake-sb-1");
  }

  async restore(_id: string): Promise<Sandbox> {
    return new VirtualSandbox("fake-sb-1");
  }

  async destroy(_id: string): Promise<void> {}

  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }

  async updateCreds(sandboxId: string, files: Record<string, string>): Promise<void> {
    if (this.rejectNextUpdate) {
      this.rejectNextUpdate = false;
      throw new Error("updateCreds rejected (simulated)");
    }
    this.updateCredsCalls.push({ sandboxId, files });
  }
}

// ── Fake host ───────────────────────────────────────────────────────────────

interface FakeSessionEntry {
  sessionId: string;
  sandboxId: string | undefined;
  state: "ready" | "suspended";
  mintedAt: number;
  userId: string;
  orgId: string;
}

class FakeRotateHost implements RotateHost {
  readonly sessions: FakeSessionEntry[] = [];
  readonly mintedAtUpdates: Array<{ sessionId: string; mintedAt: number }> = [];

  addSession(entry: FakeSessionEntry): void {
    this.sessions.push(entry);
  }

  listRotatableSessions(): FakeSessionEntry[] {
    return [...this.sessions];
  }

  recordTokenMintedAt(sessionId: string, mintedAt: number): void {
    const entry = this.sessions.find((s) => s.sessionId === sessionId);
    if (entry) entry.mintedAt = mintedAt;
    this.mintedAtUpdates.push({ sessionId, mintedAt });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const AGE_13H = 13 * 60 * 60 * 1000;
const AGE_2H = 2 * 60 * 60 * 1000;
const MAX_AGE_12H = 12 * 60 * 60 * 1000;

function msAgo(ms: number): number {
  return Date.now() - ms;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("rotate-sweep", () => {
  let db: AppDb;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const pg = await freshTestPgDb();
    db = pg.appDb;
    cleanup = pg.cleanup;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
  });

  it("rotates a ready session whose token is 13 h old", async () => {
    const provider = new FakeCredsMountProvider(true);
    const host = new FakeRotateHost();
    host.addSession({
      sessionId: "sess-a",
      sandboxId: "sb-a",
      state: "ready",
      mintedAt: msAgo(AGE_13H),
      userId: "u1",
      orgId: "o1",
    });

    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });

    // A new token row was minted.
    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "sess-a"));
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).toBeNull();

    // updateCreds was called with the correct sandboxId and a token value.
    expect(provider.updateCredsCalls.length).toBe(1);
    expect(provider.updateCredsCalls[0].sandboxId).toBe("sb-a");
    const pushedToken = provider.updateCredsCalls[0].files.token;
    expect(pushedToken).toMatch(/^st_[0-9a-f]{48}$/);

    // The minted token matches the DB row.
    const stokedHash = rows[0].tokenHash;
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(pushedToken).digest("hex")).toBe(stokedHash);

    // mintedAt map was updated; a second pass within 12 h is a no-op.
    expect(host.mintedAtUpdates.length).toBe(1);
    expect(host.mintedAtUpdates[0].sessionId).toBe("sess-a");

    const prevUpdateCount = provider.updateCredsCalls.length;
    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });
    expect(provider.updateCredsCalls.length).toBe(prevUpdateCount);
  });

  it("does not rotate a session whose token is only 2 h old", async () => {
    const provider = new FakeCredsMountProvider(true);
    const host = new FakeRotateHost();
    host.addSession({
      sessionId: "sess-b",
      sandboxId: "sb-b",
      state: "ready",
      mintedAt: msAgo(AGE_2H),
      userId: "u1",
      orgId: "o1",
    });

    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });

    expect(provider.updateCredsCalls.length).toBe(0);
    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "sess-b"));
    expect(rows.length).toBe(0);
  });

  it("skips sessions when the provider has no credsMount capability", async () => {
    const provider = new FakeCredsMountProvider(false);
    const host = new FakeRotateHost();
    host.addSession({
      sessionId: "sess-c",
      sandboxId: "sb-c",
      state: "ready",
      mintedAt: msAgo(AGE_13H),
      userId: "u1",
      orgId: "o1",
    });

    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });

    expect(provider.updateCredsCalls.length).toBe(0);
    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "sess-c"));
    expect(rows.length).toBe(0);
  });

  it("isolates per-session errors — session B rotates even when session A rejects", async () => {
    const provider = new FakeCredsMountProvider(true);
    const host = new FakeRotateHost();

    host.addSession({
      sessionId: "sess-err",
      sandboxId: "sb-err",
      state: "ready",
      mintedAt: msAgo(AGE_13H),
      userId: "u-err",
      orgId: "o1",
    });
    host.addSession({
      sessionId: "sess-ok",
      sandboxId: "sb-ok",
      state: "ready",
      mintedAt: msAgo(AGE_13H),
      userId: "u-ok",
      orgId: "o1",
    });

    // The first updateCreds call (for sess-err) will reject.
    provider.rejectNextUpdate = true;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });

    consoleSpy.mockRestore();

    // Only sess-ok was updated (the rejection was for sess-err).
    expect(provider.updateCredsCalls.length).toBe(1);
    expect(provider.updateCredsCalls[0].sandboxId).toBe("sb-ok");

    // mintedAt updated only for sess-ok.
    const okUpdate = host.mintedAtUpdates.find((u) => u.sessionId === "sess-ok");
    expect(okUpdate).toBeDefined();
    const errUpdate = host.mintedAtUpdates.find((u) => u.sessionId === "sess-err");
    expect(errUpdate).toBeUndefined();
  });

  it("rotates a suspended-state session (Secret PATCH works on suspended pods)", async () => {
    const provider = new FakeCredsMountProvider(true);
    const host = new FakeRotateHost();
    host.addSession({
      sessionId: "sess-susp",
      sandboxId: "sb-susp",
      state: "suspended",
      mintedAt: msAgo(AGE_13H),
      userId: "u1",
      orgId: "o1",
    });

    await runRotateSweep({ host, provider, db, maxAgeMs: MAX_AGE_12H });

    expect(provider.updateCredsCalls.length).toBe(1);
    expect(provider.updateCredsCalls[0].sandboxId).toBe("sb-susp");

    const rows = await db.select().from(sandboxTokens).where(eq(sandboxTokens.sessionId, "sess-susp"));
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("startRotateSweep fires on the interval and can be stopped", async () => {
    vi.useFakeTimers();
    const provider = new FakeCredsMountProvider(true);
    const host = new FakeRotateHost();
    host.addSession({
      sessionId: "sess-tick",
      sandboxId: "sb-tick",
      state: "ready",
      mintedAt: 0, // epoch — always eligible
      userId: "u1",
      orgId: "o1",
    });

    const INTERVAL_MS = 60 * 60 * 1000; // 1 h

    const handle = startRotateSweep({
      host,
      provider,
      db,
      intervalMs: INTERVAL_MS,
      maxAgeMs: MAX_AGE_12H,
    });

    // Advance by one interval — sweep fires.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(provider.updateCredsCalls.length).toBe(1);

    handle.stop();

    // Advance another interval — no more calls.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(provider.updateCredsCalls.length).toBe(1);
  });
});
