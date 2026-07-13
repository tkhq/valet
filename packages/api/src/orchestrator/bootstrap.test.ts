/**
 * Wake bootstrap: `ensureTodayJournal` creates `journal/YYYY-MM-DD.md`
 * (UTC date) if absent, and is idempotent.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { readFile, writeFile, type MemoryScope } from "../services/memory.js";
import { ensureTodayJournal, todayJournalPath } from "./bootstrap.js";

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

const scope: MemoryScope = { owner: { type: "user", id: "local-user" }, actorUserId: "local-user" };

describe("todayJournalPath", () => {
  it("formats as journal/YYYY-MM-DD.md in UTC", () => {
    const utcNoon = new Date("2026-07-13T12:00:00.000Z");
    expect(todayJournalPath(utcNoon)).toBe("journal/2026-07-13.md");
  });

  it("uses the UTC date even when local wall-clock would roll to a different day", () => {
    // 23:30 UTC on the 13th is still the 13th in UTC regardless of host TZ.
    const lateUtc = new Date("2026-07-13T23:30:00.000Z");
    expect(todayJournalPath(lateUtc)).toBe("journal/2026-07-13.md");
  });
});

describe("ensureTodayJournal", () => {
  it("creates today's journal file with type journal-entry when absent", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const path = await ensureTodayJournal(db, scope);
    expect(path).toBe(todayJournalPath());

    const result = await readFile(db, scope, path);
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.file.type).toBe("journal-entry");
      expect(result.rendered.length).toBeGreaterThan(0);
    }
  });

  it("is idempotent: a second call does not bump the version or touch content", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    const path = await ensureTodayJournal(db, scope);
    const first = await readFile(db, scope, path);
    expect(first.kind).toBe("file");

    await ensureTodayJournal(db, scope);
    const second = await readFile(db, scope, path);
    expect(second.kind).toBe("file");
    if (first.kind === "file" && second.kind === "file") {
      expect(second.file.version).toBe(first.file.version);
      expect(second.file.updatedAt).toBe(first.file.updatedAt);
    }
  });

  it("leaves a pre-existing journal entry (e.g. hand-written earlier that day) untouched", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const path = todayJournalPath();
    await writeFile(db, scope, { path, content: "# Already here\n\nCustom content.\n", type: "journal-entry" });

    await ensureTodayJournal(db, scope);

    const result = await readFile(db, scope, path);
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.rendered).toContain("Custom content.");
    }
  });
});
