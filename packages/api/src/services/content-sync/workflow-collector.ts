/**
 * Workflow definitions mirrored from a repository, on the rail
 * `content-sync/collector.ts` defines. Read that file first: it states the
 * rules every collector holds to. Design:
 * `docs/specs/2026-08-24-workflows-mvp-design.md`, decisions 4 to 9.
 *
 * Two roots hold definitions: `.valet/workflows/**`, the folder that holds
 * Valet automation, and a top-level `workflows/**` for a repository whose
 * authors want no dot folder. Nested directories are allowed under either,
 * because a large repository wants
 * `.valet/workflows/billing/monthly-invoice.yaml`.
 *
 * Identity is `(source_id, upstream_path)` and nothing else. Not the name,
 * and not any id the file writes. Renaming a file therefore deletes one
 * workflow and creates another, which is the honest reading of a rename in a
 * system with no rename event: the run history of the old path stays where it
 * is.
 *
 * There is no `walkDirectory`. A commit whose tree GitHub cut mirrors no
 * workflow, and the sweep reports `directory-walk`, which already forbids
 * every delete. A one-level fallback would miss every nested definition and
 * then read the rest as deleted.
 *
 * A source's `subpath` does not narrow this collector, which is the one place
 * it parts from `skill-collector.ts`. The subpath says where a repository
 * keeps its SKILLS; `.valet/` is repository-level configuration and is read
 * from the root whatever that setting holds. A source that sets a subpath and
 * expects it to hide `.valet/workflows` would be surprised, so say it here.
 */
import { and, eq, inArray } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type ValidateEnvironment,
  type WorkflowFile,
} from "@valet/workflow";
import type { AppDb } from "../../lib/drizzle.js";
import {
  workflowDefinitions,
  workflowRuns,
  workflowVersions,
  type ContentSourceRow,
} from "../../schema/index.js";
import {
  disarmWorkflowTriggers,
  newWorkflowId,
  purgeWorkflowRows,
} from "../../workflows/service.js";
import type { SkillTreeEntry } from "../skill-repo-reader.js";
import type {
  CollectorDiscoverContext,
  CollectorNoticeContext,
  CollectorPass,
  CollectorReconcileContext,
  CollectorReconcileResult,
  ContentCollector,
  ContentManifestEntry,
} from "./collector.js";

/** The two roots that hold definitions. */
const WORKFLOW_ROOTS = [".valet/workflows", "workflows"] as const;

/** A run in one of these has not settled, so the workflow that holds it is
 * disarmed rather than deleted. Mirrors the `has_active_runs` guard in
 * `workflows/service.ts`. */
const UNSETTLED = ["pending", "running", "parked", "terminalizing"] as const;

export interface WorkflowCollectorDeps {
  /**
   * The dag validator's environment. With it, a file that names an unknown
   * model or an unknown tool service fails at sync with the validator's own
   * message, instead of at run time inside a node. Optional, so a test that
   * mirrors a plain graph needs no plugin catalog.
   */
  env?: ValidateEnvironment;
}

export class WorkflowCollector implements ContentCollector {
  readonly kind = "workflows" as const;

  constructor(private readonly deps: WorkflowCollectorDeps = {}) {}

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    const candidates: WorkflowCandidate[] = [];
    for (const entry of entries) {
      // A symlink's blob holds a path string and not a definition, so mode
      // 120000 is not a candidate.
      if (entry.type !== "blob" || entry.mode === "120000") continue;
      const root = rootFor(entry.path);
      if (root === null || !hasWorkflowExtension(entry.path)) continue;
      candidates.push({
        name: nameFromPath(entry.path),
        path: entry.path,
        blobSha: entry.sha,
        root,
      });
    }
    // Path order, so the manifest hash follows the commit and not the order
    // GitHub listed the tree in.
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return new WorkflowPass(candidates, source, this.deps.env);
  }
}

interface WorkflowCandidate extends ContentManifestEntry {
  /** Which root claimed it. Under `.valet/workflows` a file with no `valet:`
   * key is a mistake worth naming, because that folder is unambiguous. Under
   * a top-level `workflows/` it is a file that belongs to something else. */
  root: string;
}

/** The root that claims `path`, or null. A file sitting directly in `.valet/`
 * is not under `.valet/workflows` and is never a candidate, which keeps this
 * away from `.valet/prebuild.yaml`. */
function rootFor(path: string): string | null {
  for (const root of WORKFLOW_ROOTS) {
    if (path.startsWith(`${root}/`) && path.length > root.length + 1) return root;
  }
  return null;
}

function hasWorkflowExtension(path: string): boolean {
  return WORKFLOW_FILE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** The file's base name without its extension. The file's own `name` key wins
 * once the body is read; this is the fallback, and the name the manifest
 * hashes before any body is read. */
function nameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

class WorkflowPass implements CollectorPass {
  readonly kind = "workflows" as const;
  readonly readEntries: ContentManifestEntry[];
  readonly manifestEntries: ContentManifestEntry[];
  readonly text = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly discovered: number;
  readonly excluded = 0;

  /** Set when a source that does not collect workflows held some anyway. */
  private readonly skippedForOwner: number;
  /** Workflows kept because a run of theirs has not settled, by name. */
  private disarmed: string[] = [];

  constructor(
    private readonly candidates: WorkflowCandidate[],
    source: ContentSourceRow,
    private readonly env: ValidateEnvironment | undefined,
  ) {
    this.discovered = candidates.length;
    // A user source collects no workflows: personal workflow sync is out of
    // scope. `notice` says so once for the source rather than once per file.
    const collects = source.ownerType !== "user";
    this.skippedForOwner = collects ? 0 : candidates.length;
    this.readEntries = collects
      ? candidates.map(({ name, path, blobSha }) => ({ name, path, blobSha }))
      : [];
    this.manifestEntries = this.readEntries;
  }

  unreadWarning(path: string): string {
    return `${path} was in the repository listing and could not be read, so this workflow was not mirrored. Valet reads it again on the next sync. If it stays, check that the path is a file and not a symbolic link.`;
  }

  /**
   * Brings this source's mirrored workflows in line with what the commit
   * holds, keyed by path.
   *
   * A file that fails to parse or to validate is warned about and skipped,
   * and the row it already has is KEPT. That row is a working mirror of an
   * older commit, and a typo pushed to the file must not take a working
   * workflow away.
   */
  async reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult> {
    const { db, source, text, discovery, commitSha, now } = ctx;
    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    if (source.ownerType === "user") {
      return { imported, updated, deleted: 0, keptStale: [], warnings };
    }

    const existing = await db
      .select()
      .from(workflowDefinitions)
      .where(
        and(eq(workflowDefinitions.sourceId, source.id), eq(workflowDefinitions.origin, "repo")),
      );
    const byPath = new Map(
      existing.flatMap((row) => (row.upstreamPath === null ? [] : [[row.upstreamPath, row] as const])),
    );
    /**
     * Paths the repository still holds. Seeded from DISCOVERY, before any
     * body is read, because presence in the tree is what "still there" means
     * and a body is not needed to know it.
     *
     * Reading it from `text` instead would delete a mirror on a transient
     * fault: `readContents` treats a file it could not fetch as a normal
     * outcome, warns, and still calls reconcile, so one 404 in the window
     * between the tree read and the file read would take the definition, its
     * versions, its schedules and its webhook, and the next sync would
     * re-import the file under a new id that the old runs do not point at.
     * `skill-collector.ts` seeds from `readEntries` for the same reason.
     */
    const upstream = new Set(this.readEntries.map((entry) => entry.path));

    for (const candidate of this.candidates) {
      const raw = text.get(candidate.path);
      if (raw === undefined) continue;

      const parsed = this.readFile(raw, candidate);
      if (parsed.kind === "skip") continue;
      if (parsed.kind === "warn") {
        warnings.push(parsed.message);
        continue;
      }

      // Decision 9: a team may not yet run tool nodes on a trigger, so a
      // team-owned file that declares one is mirrored with its triggers
      // unarmed. Task 6 arms triggers; until then nothing here arms any,
      // and the warning is what tells the team why.
      const gated = teamTriggerGate(source, parsed.file);
      if (gated !== null) warnings.push(`${candidate.path}: ${gated}`);

      const name = parsed.file.name ?? candidate.name;
      const row = byPath.get(candidate.path);
      if (row === undefined) {
        const id = newWorkflowId("wf");
        await db.insert(workflowDefinitions).values({
          id,
          // A mirrored row copies its owner from the source: a team source
          // produces team-owned workflows, an org source org-owned ones.
          orgId: source.orgId,
          ownerType: source.ownerType,
          ownerId: source.ownerId,
          name,
          definition: parsed.file.definition,
          origin: "repo",
          sourceId: source.id,
          upstreamPath: candidate.path,
          contentSha: candidate.blobSha,
          createdAt: now(),
          updatedAt: now(),
        });
        await snapshot(db, id, 1, name, parsed.file.definition, commitSha, now());
        imported += 1;
        continue;
      }

      // The blob sha decides whether the FILE changed; the definition hash
      // decides whether a VERSION is worth minting. A rename of the file's
      // `name` key changes the row and mints nothing, matching the product
      // edit path.
      if (row.contentSha === candidate.blobSha && row.name === name) continue;
      await db
        .update(workflowDefinitions)
        .set({
          name,
          definition: parsed.file.definition,
          contentSha: candidate.blobSha,
          updatedAt: now(),
        })
        .where(eq(workflowDefinitions.id, row.id));
      if (!sameGraph(parsed.file.definition, row.definition)) {
        await snapshot(
          db,
          row.id,
          await nextVersion(db, row.id),
          name,
          parsed.file.definition,
          commitSha,
          now(),
        );
      }
      updated += 1;
    }

    const stale = [...byPath.values()].filter(
      (row) => row.upstreamPath !== null && !upstream.has(row.upstreamPath),
    );
    // A narrower scan's absences prove nothing, so a cut tree deletes nothing.
    if (discovery === "directory-walk") {
      return { imported, updated, deleted: 0, keptStale: stale.map((row) => row.name), warnings };
    }

    let deleted = 0;
    const disarmed: string[] = [];
    const unsettled = await workflowsWithUnsettledRuns(
      db,
      stale.map((row) => row.id),
    );
    for (const row of stale) {
      if (unsettled.has(row.id)) {
        // The run keeps its own snapshot of the definition, so it finishes
        // either way. Deleting the row would orphan it from every list view,
        // so disarm instead: nothing new starts, and the next sync after the
        // run settles deletes the row.
        await disarmWorkflowTriggers(db, source.orgId, row.id);
        disarmed.push(row.name);
        continue;
      }
      // Scoped by source and origin a second time, so this delete stays off a
      // local workflow and off another source's rows even if the ids were
      // wrong.
      const confirmed = await db
        .select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.id, row.id),
            eq(workflowDefinitions.sourceId, source.id),
            eq(workflowDefinitions.origin, "repo"),
          ),
        );
      if (confirmed.length === 0) continue;
      await purgeWorkflowRows(db, source.orgId, row.id);
      deleted += 1;
    }
    this.disarmed = disarmed;
    for (const name of disarmed) {
      warnings.push(
        `${name}: this workflow's file is gone from the repository, and a run of it has not settled. Valet turned its triggers off and kept it. It is removed on the first sync after the run settles.`,
      );
    }

    // A disarmed workflow waits on a run, and no commit will land to move the
    // manifest when it settles. Reporting it deferred keeps the sync
    // incomplete, so the next poll re-reads and retries the delete.
    return { imported, updated, deleted, keptStale: [], warnings, deferred: disarmed };
  }

  /** One candidate's body to a workflow file, or to what to say about it. */
  private readFile(
    raw: string,
    candidate: WorkflowCandidate,
  ): { kind: "ok"; file: WorkflowFile } | { kind: "warn"; message: string } | { kind: "skip" } {
    let value: unknown;
    try {
      // YAML 1.2 parses JSON, so one parser reads both accepted forms.
      value = parseYaml(raw);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      return {
        kind: "warn",
        message: `${candidate.path} is not valid YAML or JSON${detail}. Fix the file and push.`,
      };
    }

    const parsed = parseWorkflowFileValue(value, candidate.path, this.env ?? {});
    if (!parsed.ok) {
      // A file with no `valet:` key under a repository's own `workflows/` is
      // not a mistake: that folder belongs to the repository and may hold
      // anything. Under `.valet/workflows` the folder is unambiguous, so the
      // same file gets a warning naming the path.
      if (parsed.code === "unlabeled" && candidate.root !== ".valet/workflows") {
        return { kind: "skip" };
      }
      // The validator names the node and not the file, so the path goes in
      // front of its messages. Without it, the most common failure of this
      // feature reports a broken node and never says which file holds it.
      return { kind: "warn", message: `${candidate.path}: ${parsed.errors.join(" ")}` };
    }
    // A template in the workflow folder. The template collector owns it, and
    // discovery already put the path in `upstream`, so neither deletes the
    // other's rows.
    if (parsed.file.kind !== "workflow") return { kind: "skip" };

    // A YAML anchor that refers to itself survives the validator, which only
    // walks `version`, `policy`, `nodes` and `edges`. It then throws out of
    // `JSON.stringify` in drizzle's jsonb encoder and in
    // `definitionVersionId`, which would abort the sync for every OTHER file
    // in the same pass. One file's mistake must cost that file only.
    try {
      JSON.stringify(parsed.file.definition);
    } catch {
      return {
        kind: "warn",
        message: `${candidate.path}: this workflow refers to itself, so Valet cannot store it. Look for a YAML anchor that includes the node holding it, and write the value out in full.`,
      };
    }
    return { kind: "ok", file: parsed.file };
  }

  notice(ctx: CollectorNoticeContext): string | null {
    const lines: string[] = [];
    if (this.skippedForOwner > 0) {
      const files = this.skippedForOwner === 1 ? "file" : "files";
      lines.push(
        `Valet found ${this.skippedForOwner} workflow ${files} here and mirrored none of them. Repository workflow sync applies to team sources and org sources. Add this repository as a team source to mirror them.`,
      );
    }
    if (ctx.discovery === "directory-walk" && ctx.keptStale.length > 0) {
      const kept = ctx.keptStale.length === 1 ? "workflow" : "workflows";
      lines.push(
        `${ctx.source.repoFullName} holds more files than Valet can read in one listing, so this scan was narrower than the one that mirrored these workflows. Valet kept ${ctx.keptStale.length} mirrored ${kept} it did not reach: ${ctx.keptStale.join(", ")}.`,
      );
    }
    if (this.disarmed.length > 0) {
      const wf = this.disarmed.length === 1 ? "workflow" : "workflows";
      lines.push(
        `Valet turned the triggers off on ${this.disarmed.length} mirrored ${wf} whose file is gone and whose run has not settled: ${this.disarmed.join(", ")}. They are removed on the first sync after the runs settle.`,
      );
    }
    return lines.length === 0 ? null : lines.join("\n");
  }
}

/**
 * Decision 9. A team-owned workflow with tool nodes cannot resolve a team
 * credential outside a session someone started, so the install path refuses
 * one. The sync mirrors the definition and leaves its triggers unarmed, and
 * this is the message that says why. Org sources are unaffected: org
 * credential escalation already works.
 *
 * Returns null when there is nothing to say.
 */
function teamTriggerGate(source: ContentSourceRow, file: WorkflowFile): string | null {
  if (source.ownerType !== "team") return null;
  if (file.schedule === undefined && (file.events === undefined || file.events.length === 0)) {
    return null;
  }
  const nodes = file.definition.nodes;
  if (!nodes.some((node) => node.type === "tool")) return null;
  return `this workflow uses tool actions and declares a trigger. A team cannot run tool actions on a trigger yet, so Valet mirrored the workflow and left the trigger off. Run it by hand, or move the repository to an org source.`;
}

/**
 * True when two definitions are the same graph.
 *
 * `definitionVersionId` cannot answer this here. It hashes `JSON.stringify`
 * with no key canonicalization, and one side of the compare is a fresh YAML
 * parse holding the file's key order while the other came back from Postgres
 * `jsonb`, which sorts keys. The two hashes then differ for a byte-identical
 * graph, and every file edit would mint a version even when only a comment or
 * the file's `name` moved. Sorting both sides first removes that.
 */
function sameGraph(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The same value with every object's keys in sorted order. Arrays keep their
 * order, which carries meaning in a node or edge list. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}

/** Which of `ids` hold a run that has not settled. One query, and none at all
 * when nothing is stale. */
async function workflowsWithUnsettledRuns(db: AppDb, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(and(inArray(workflowRuns.workflowId, ids), inArray(workflowRuns.status, [...UNSETTLED])));
  return new Set(rows.map((row) => row.workflowId));
}

/** A version row carrying the commit that produced it, so the version list
 * reads as one timeline whether a push or a person made the entry. */
async function snapshot(
  db: AppDb,
  workflowId: string,
  version: number,
  name: string,
  definition: unknown,
  commitSha: string,
  now: number,
): Promise<void> {
  await db.insert(workflowVersions).values({
    id: newWorkflowId("wfv"),
    workflowId,
    version,
    name,
    definition,
    origin: "repo",
    sourceCommit: commitSha,
    createdAt: now,
  });
}

async function nextVersion(db: AppDb, workflowId: string): Promise<number> {
  const rows = await db
    .select({ version: workflowVersions.version })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(workflowVersions.version);
  return (rows[rows.length - 1]?.version ?? 0) + 1;
}
