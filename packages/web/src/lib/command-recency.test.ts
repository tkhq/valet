import { describe, expect, it } from "vitest";
import {
  COMMAND_RECENCY_MAX_ENTRIES,
  COMMAND_RECENCY_STORAGE_KEY,
  readCommandRecency,
  recordCommandUse,
} from "./command-recency";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => map.get(COMMAND_RECENCY_STORAGE_KEY),
  };
}

describe("readCommandRecency", () => {
  it("returns an empty map for an absent key", () => {
    expect(readCommandRecency(memoryStorage())).toEqual({});
  });

  it("returns an empty map for bad JSON and non-object shapes", () => {
    expect(readCommandRecency(memoryStorage({ [COMMAND_RECENCY_STORAGE_KEY]: "{nope" }))).toEqual({});
    expect(readCommandRecency(memoryStorage({ [COMMAND_RECENCY_STORAGE_KEY]: "[1,2]" }))).toEqual({});
    expect(readCommandRecency(memoryStorage({ [COMMAND_RECENCY_STORAGE_KEY]: "null" }))).toEqual({});
  });

  it("drops non-numeric entries and keeps numeric ones", () => {
    const storage = memoryStorage({
      [COMMAND_RECENCY_STORAGE_KEY]: JSON.stringify({ status: 100, bad: "x", worse: null }),
    });
    expect(readCommandRecency(storage)).toEqual({ status: 100 });
  });

  it("returns an empty map when storage.getItem throws", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readCommandRecency(storage)).toEqual({});
  });
});

describe("recordCommandUse", () => {
  it("stamps the command and persists the map", () => {
    const storage = memoryStorage();
    const map = recordCommandUse("skill:review", 1234, storage);
    expect(map).toEqual({ "skill:review": 1234 });
    expect(JSON.parse(storage.dump() ?? "{}")).toEqual({ "skill:review": 1234 });
  });

  it("updates an existing stamp in place", () => {
    const storage = memoryStorage();
    recordCommandUse("status", 1, storage);
    const map = recordCommandUse("status", 2, storage);
    expect(map).toEqual({ status: 2 });
  });

  it("trims to the newest entries at the cap", () => {
    const storage = memoryStorage();
    for (let i = 0; i <= COMMAND_RECENCY_MAX_ENTRIES; i++) {
      recordCommandUse(`cmd-${i}`, i, storage);
    }
    const map = readCommandRecency(storage);
    expect(Object.keys(map)).toHaveLength(COMMAND_RECENCY_MAX_ENTRIES);
    // The oldest stamp drops; the newest survives.
    expect(map["cmd-0"]).toBeUndefined();
    expect(map[`cmd-${COMMAND_RECENCY_MAX_ENTRIES}`]).toBe(COMMAND_RECENCY_MAX_ENTRIES);
  });

  it("still returns the updated map when the write fails", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(recordCommandUse("status", 42, storage)).toEqual({ status: 42 });
  });
});
