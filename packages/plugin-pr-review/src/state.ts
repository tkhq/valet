import { readFile, writeFile } from "node:fs/promises";
import type { ScopedPluginStore } from "@valet/engine";
import type { Finding } from "./types.js";

/** A finding tracked across the commits of one pull request. */
export interface TrackedFinding extends Finding {
  /** Stable across reviews: `f<n>` in the order findings were first reported. */
  id: string;
  status: "open" | "resolved";
  /** Head commit of the review that first reported it. */
  firstSeen: string;
  /** Head commit of the latest review that kept it open, or that resolved it. */
  lastSeen: string;
  /** Why it was resolved, from the recheck. */
  resolution?: string;
}

/** One review of one head commit. */
export interface ReviewRound {
  head: string;
  mode: "full" | "incremental";
  at: string;
  newFindings: string[];
  /** Findings a later commit fixed. */
  resolved: string[];
  /** Findings a recheck refuted with no change to their code. Absent: none. */
  withdrawn?: string[];
  /** Memory paths of the team rules the reviewer was given. Absent: none. */
  rules?: string[];
}

/** Everything the reviewer remembers about one pull request. */
export interface PullRequestReviewState {
  version: 1;
  /** e.g. `tkhq/valet#1120`. */
  key: string;
  mergeBase: string;
  lastReviewedHead: string;
  /** Open and resolved findings, in report order. */
  findings: TrackedFinding[];
  rounds: ReviewRound[];
  /** Next numeric id for `TrackedFinding.id`. */
  nextId: number;
}

/** Where review state lives. The plugin uses its PluginStore; the CLI uses a file. */
export interface ReviewStateStore {
  get(key: string): Promise<{ state: PullRequestReviewState; revision?: number } | undefined>;
  /** Pass the revision read by `get` so a concurrent review of the same PR cannot overwrite this one. */
  put(state: PullRequestReviewState, revision?: number): Promise<void>;
}

const COLLECTION = "pr-review-state";

/** State in the plugin's PluginStore, one document per PR. Writes are revision-checked. */
export function pluginStoreReviewState(store: ScopedPluginStore): ReviewStateStore {
  return {
    async get(key) {
      const doc = await store.get<PullRequestReviewState>(COLLECTION, key);
      return doc ? { state: doc.doc, revision: doc.revision } : undefined;
    },
    async put(state, revision) {
      await store.put(COLLECTION, state.key, state, revision !== undefined ? { ifRevision: revision } : undefined);
    },
  };
}

/** In-memory store, for tests and one-process runs. */
export function memoryReviewState(): ReviewStateStore {
  const docs = new Map<string, PullRequestReviewState>();
  return {
    async get(key) {
      const state = docs.get(key);
      return state ? { state: structuredClone(state) } : undefined;
    },
    async put(state) {
      docs.set(state.key, structuredClone(state));
    },
  };
}

export function openFindings(state: PullRequestReviewState | undefined): TrackedFinding[] {
  return state?.findings.filter((f) => f.status === "open") ?? [];
}

/** State in a local JSON file keyed by PR, for the CLI. */
export function fileReviewState(path: string): ReviewStateStore {
  const load = async (): Promise<Record<string, PullRequestReviewState>> =>
    readFile(path, "utf8").then(
      (text) => JSON.parse(text) as Record<string, PullRequestReviewState>,
      () => ({}),
    );
  return {
    async get(key) {
      const state = (await load())[key];
      return state ? { state } : undefined;
    },
    async put(state) {
      const all = await load();
      all[state.key] = state;
      await writeFile(path, `${JSON.stringify(all, null, 2)}\n`);
    },
  };
}
