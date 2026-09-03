/**
 * Workflow templates mirrored from a repository, on the rail
 * `content-sync/collector.ts` defines. Read that file first. Design:
 * `docs/specs/2026-08-24-workflows-mvp-design.md`, decision 11.
 *
 * A template and a definition are the same file format with a different
 * `valet:` kind, and they behave in opposite ways once mirrored. A mirrored
 * DEFINITION is a live, read-only mirror the product cannot edit. A mirrored
 * TEMPLATE is a starting point: installing it runs the unchanged
 * `installWorkflowTemplate` and produces an ordinary local workflow the
 * installer may edit, and the mirrored row keeps syncing behind it.
 *
 * The claim boundary with `workflow-collector.ts` is the FOLDER and never the
 * parsed kind. This collector claims `.valet/templates/**` and nothing else;
 * the workflow collector keeps `.valet/workflows/**` and `workflows/**`
 * whole. Deciding by parsed kind would mean a file's claim moves when someone
 * edits one line of it, and a path both collectors could claim is a path each
 * can delete from under the other.
 */
import { and, eq, inArray } from "drizzle-orm";
import { isPgUniqueViolation } from "@valet/store-postgres";
import { parse as parseYaml } from "yaml";
import {
  parseWorkflowFileValue,
  WORKFLOW_FILE_EXTENSIONS,
  type ValidateEnvironment,
  type WorkflowTemplateFile,
} from "@valet/workflow";
import type { WorkflowTemplate } from "@valet/engine";
import { workflowTemplates, type ContentSourceRow } from "../../schema/index.js";
import { newWorkflowId } from "../../workflows/service.js";
import type {
  CollectorDiscoverContext,
  CollectorNoticeContext,
  CollectorPass,
  CollectorReconcileContext,
  CollectorReconcileResult,
  ContentCollector,
  ContentManifestEntry,
} from "./collector.js";

/** The one root this collector claims. */
const TEMPLATE_ROOT = ".valet/templates";

export interface TemplateCollectorDeps {
  /** The dag validator's environment, so a template naming an unknown model
   * or tool service fails at sync rather than at install. */
  env?: ValidateEnvironment;
  /**
   * Template ids this deployment SHIPS, to the plugin that ships them.
   * Resolved once per pass. A mirrored id that collides with a shipped one is
   * refused with both names: we own one side and the repository owns the
   * other, so the collision has to be loud where it can be fixed.
   */
  reserved?: () => ReadonlyMap<string, string>;
}

export class TemplateCollector implements ContentCollector {
  readonly kind = "templates" as const;

  constructor(private readonly deps: TemplateCollectorDeps = {}) {}

  discover({ entries, source }: CollectorDiscoverContext): CollectorPass {
    const candidates: ContentManifestEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode === "120000") continue;
      if (!entry.path.startsWith(`${TEMPLATE_ROOT}/`)) continue;
      if (entry.path.length <= TEMPLATE_ROOT.length + 1) continue;
      if (!WORKFLOW_FILE_EXTENSIONS.some((ext) => entry.path.endsWith(ext))) continue;
      candidates.push({ name: baseName(entry.path), path: entry.path, blobSha: entry.sha });
    }
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return new TemplatePass(
      candidates,
      source,
      this.deps.env,
      this.deps.reserved ?? (() => new Map()),
    );
  }
}

function baseName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

class TemplatePass implements CollectorPass {
  readonly kind = "templates" as const;
  readonly readEntries: ContentManifestEntry[];
  readonly manifestEntries: ContentManifestEntry[];
  readonly text = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly discovered: number;
  readonly excluded = 0;

  /** Set when a source that does not publish templates held some anyway. */
  private readonly skippedForOwner: number;

  constructor(
    private readonly candidates: ContentManifestEntry[],
    source: ContentSourceRow,
    private readonly env: ValidateEnvironment | undefined,
    private readonly reserved: () => ReadonlyMap<string, string>,
  ) {
    this.discovered = candidates.length;
    // Decision 11 scopes a mirrored template by its source's owner: an org
    // source publishes to the org's gallery, a team source to that team.
    // A personal gallery is not a thing the product has, so a user source
    // publishes nowhere and says so once.
    const publishes = source.ownerType !== "user";
    this.skippedForOwner = publishes ? 0 : candidates.length;
    this.readEntries = publishes ? candidates : [];
    this.manifestEntries = this.readEntries;
  }

  unreadWarning(path: string): string {
    return `${path} was in the repository listing and could not be read, so this template was not mirrored. Valet reads it again on the next sync.`;
  }

  /**
   * Brings this source's mirrored templates in line with the commit.
   *
   * The stale delete runs FIRST here, unlike the workflow collector. This
   * table carries a second unique key, `(org_id, owner_type, owner_id,
   * template_id)`, so renaming a file while keeping its declared id would
   * otherwise insert the new path against a row the old path still holds and
   * fail the whole pass on a constraint. Deleting what the commit no longer
   * holds before writing what it does makes a rename an ordinary delete and
   * insert.
   */
  async reconcile(ctx: CollectorReconcileContext): Promise<CollectorReconcileResult> {
    const { db, source, text, discovery, now } = ctx;
    const warnings: string[] = [];
    let imported = 0;
    let updated = 0;

    if (source.ownerType === "user") {
      return { imported, updated, deleted: 0, keptStale: [], warnings };
    }

    const existing = await db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.sourceId, source.id), eq(workflowTemplates.origin, "repo")));
    // Seeded from discovery, before any body is read: a file the rail could
    // not fetch is still in the tree, and its row must not read as deleted.
    const upstream = new Set(this.readEntries.map((entry) => entry.path));

    const stale = existing.filter((row) => !upstream.has(row.upstreamPath));
    let deleted = 0;
    if (discovery === "directory-walk") {
      // A narrower scan's absences prove nothing.
      if (stale.length > 0) {
        return {
          imported,
          updated,
          deleted: 0,
          keptStale: stale.map((row) => row.templateId),
          warnings,
        };
      }
    } else if (stale.length > 0) {
      await db.delete(workflowTemplates).where(
        and(
          inArray(
            workflowTemplates.id,
            stale.map((row) => row.id),
          ),
          eq(workflowTemplates.sourceId, source.id),
          eq(workflowTemplates.origin, "repo"),
        ),
      );
      deleted = stale.length;
    }

    const byPath = new Map(
      existing.filter((row) => upstream.has(row.upstreamPath)).map((row) => [row.upstreamPath, row]),
    );
    const shipped = this.reserved();
    /** Ids claimed within THIS pass, so two files in one repository claiming
     * one id report the collision rather than racing the unique index. */
    const claimed = new Set<string>();

    for (const candidate of this.candidates) {
      const raw = text.get(candidate.path);
      if (raw === undefined) continue;

      const parsed = this.readFile(raw, candidate.path);
      if (parsed.kind === "skip") continue;
      if (parsed.kind === "warn") {
        warnings.push(parsed.message);
        continue;
      }
      const file = parsed.file;
      const templateId = file.template.id;

      const ships = shipped.get(templateId);
      if (ships !== undefined) {
        warnings.push(
          `${candidate.path} declares the template id "${templateId}", which Valet already ships in ${ships}. Rename the template in the file, or remove it and install the one Valet ships.`,
        );
        continue;
      }
      if (claimed.has(templateId)) {
        warnings.push(
          `${candidate.path} declares the template id "${templateId}", which another file in this repository already claims. Give one of them a different id.`,
        );
        continue;
      }
      claimed.add(templateId);

      const row = byPath.get(candidate.path);
      const template = toTemplate(file);
      if (row === undefined) {
        try {
          await db.insert(workflowTemplates).values({
            id: newWorkflowId("wftpl"),
            orgId: source.orgId,
            ownerType: source.ownerType,
            ownerId: source.ownerId,
            templateId,
            origin: "repo",
            sourceId: source.id,
            upstreamPath: candidate.path,
            contentSha: candidate.blobSha,
            template,
            createdAt: now(),
            updatedAt: now(),
          });
        } catch (err) {
          // `workflow_templates_owner_template` spans every source that
          // shares an owner, and the two guards above see only the shipped
          // catalog and this pass. A second REPOSITORY tracked for the same
          // team can claim an id the first already holds, and letting the
          // violation escape would abort the pass and error the source on
          // every poll for a mistake in one file.
          if (!isPgUniqueViolation(err)) throw err;
          warnings.push(
            `${candidate.path} declares the template id "${templateId}", which another repository tracked for this owner already publishes. Give one of them a different id.`,
          );
          continue;
        }
        imported += 1;
        continue;
      }
      if (row.contentSha === candidate.blobSha && row.templateId === templateId) continue;
      try {
        await db
          .update(workflowTemplates)
          .set({ templateId, template, contentSha: candidate.blobSha, updatedAt: now() })
          .where(eq(workflowTemplates.id, row.id));
      } catch (err) {
        // Same index, reached the other way: a file that CHANGES its declared
        // id to one another source holds.
        if (!isPgUniqueViolation(err)) throw err;
        warnings.push(
          `${candidate.path} now declares the template id "${templateId}", which another repository tracked for this owner already publishes. Give one of them a different id.`,
        );
        continue;
      }
      updated += 1;
    }

    return { imported, updated, deleted, keptStale: [], warnings };
  }

  private readFile(
    raw: string,
    path: string,
  ):
    | { kind: "ok"; file: WorkflowTemplateFile }
    | { kind: "warn"; message: string }
    | { kind: "skip" } {
    let value: unknown;
    try {
      value = parseYaml(raw);
    } catch (err) {
      const detail = err instanceof Error ? `: ${err.message}` : "";
      return { kind: "warn", message: `${path} is not valid YAML or JSON${detail}. Fix the file and push.` };
    }
    const parsed = parseWorkflowFileValue(value, path, this.env ?? {});
    if (!parsed.ok) {
      // `.valet/templates` is unambiguous, so even an unlabeled file is worth
      // naming here: someone put it in the templates folder on purpose.
      return { kind: "warn", message: `${path}: ${parsed.errors.join(" ")}` };
    }
    if (parsed.file.kind !== "template") {
      return {
        kind: "warn",
        message: `${path} is a workflow definition and it sits in the templates folder. Move it to .valet/workflows/ and push, or change its "valet:" key to a template.`,
      };
    }
    try {
      JSON.stringify(parsed.file.definition);
    } catch {
      return {
        kind: "warn",
        message: `${path}: this template refers to itself, so Valet cannot store it. Look for a YAML anchor that includes the node holding it, and write the value out in full.`,
      };
    }
    return { kind: "ok", file: parsed.file };
  }

  notice(ctx: CollectorNoticeContext): string | null {
    const lines: string[] = [];
    if (this.skippedForOwner > 0) {
      const files = this.skippedForOwner === 1 ? "file" : "files";
      lines.push(
        `Valet found ${this.skippedForOwner} template ${files} here and published none of them. A mirrored template goes to a team's gallery or the org's, so it needs a team source or an org source.`,
      );
    }
    if (ctx.discovery === "directory-walk" && ctx.keptStale.length > 0) {
      lines.push(
        `${ctx.source.repoFullName} holds more files than Valet can read in one listing, so this scan was narrower than the one that mirrored these templates. Valet kept ${ctx.keptStale.length} it did not reach: ${ctx.keptStale.join(", ")}.`,
      );
    }
    return lines.length === 0 ? null : lines.join("\n");
  }
}

/** The file's gallery half plus its graph, in the shape the catalog serves.
 * The triggers travel with it, so installing a mirrored template arms what
 * the file declared exactly as installing a shipped one does. */
function toTemplate(file: WorkflowTemplateFile): WorkflowTemplate {
  return {
    ...file.template,
    definition: file.definition,
    ...(file.schedule === undefined ? {} : { schedule: file.schedule }),
    ...(file.events === undefined ? {} : { events: file.events }),
  };
}
