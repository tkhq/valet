/**
 * `--pull-flagged` (TKAI-334): harvest thumbs-rated sessions into the eval
 * corpus. Reads rated sessions straight from the database (see the api's
 * eval-flagged module), extracts one Trajectory per thread, and writes one
 * JSON file per session under `evals/baselines/flagged/`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  openEvalDataSource,
  readFlaggedSessions,
  type FlaggedSessionExport,
} from "@valet/api/eval-flagged";
import type { MessageEntry, SessionEntry } from "@valet/engine";
import { extractTrajectory } from "./trajectory.js";
import type { Trajectory } from "./types.js";

export interface PullFlaggedOptions {
  /** Postgres connection string. Wins over pgDataDir. */
  databaseUrl?: string;
  /** Embedded PGlite data dir (the api must not be running against it). */
  pgDataDir?: string;
  /** Which ratings to pull. Default positive (the benchmark corpus). */
  rating?: "positive" | "negative";
  /** Output dir; files land in `<dir>/flagged/`. */
  baselinesDir: string;
  now?: () => Date;
}

export interface FlaggedPullFile {
  sessionId: string;
  rating: "positive" | "negative";
  title: string | null;
  ratedAt: number;
  pulledAt: string;
  trajectories: Trajectory[];
}

function firstUserContent(entries: SessionEntry[]): string {
  const user = entries.find((e): e is MessageEntry => e.type === "message" && e.role === "user");
  return user?.content ?? "";
}

function firstAssistantModel(entries: SessionEntry[]): string {
  const assistant = entries.find(
    (e): e is MessageEntry => e.type === "message" && e.role === "assistant" && e.model !== undefined,
  );
  return assistant?.model ?? "unknown";
}

/** Build the per-session export file from raw thread entries. */
export function flaggedPullFile(
  flagged: FlaggedSessionExport,
  pulledAt: string,
): FlaggedPullFile {
  const trajectories = flagged.threads.map(({ threadId, entries }) =>
    extractTrajectory({
      caseId: `flagged:${flagged.sessionId}:${threadId}`,
      prompt: firstUserContent(entries),
      model: firstAssistantModel(entries),
      durationMs: 0,
      entries,
      metadata: { sessionId: flagged.sessionId, threadId, rating: flagged.rating },
    }),
  );
  return {
    sessionId: flagged.sessionId,
    rating: flagged.rating,
    title: flagged.title,
    ratedAt: flagged.ratedAt,
    pulledAt,
    trajectories,
  };
}

/** Pull rated sessions and write them under `<baselinesDir>/flagged/`. */
export async function pullFlagged(opts: PullFlaggedOptions): Promise<{ files: string[] }> {
  const src = await openEvalDataSource({
    ...(opts.databaseUrl !== undefined ? { databaseUrl: opts.databaseUrl } : {}),
    ...(opts.pgDataDir !== undefined ? { pgDataDir: opts.pgDataDir } : {}),
  });
  try {
    const flagged = await readFlaggedSessions(src, { rating: opts.rating ?? "positive" });
    const outDir = join(opts.baselinesDir, "flagged");
    await mkdir(outDir, { recursive: true });
    const pulledAt = (opts.now ?? (() => new Date()))().toISOString();
    const files: string[] = [];
    for (const session of flagged) {
      const file = flaggedPullFile(session, pulledAt);
      const path = join(outDir, `${session.sessionId}.json`);
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      files.push(path);
    }
    return { files };
  } finally {
    await src.close();
  }
}
