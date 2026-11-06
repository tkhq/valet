/**
 * `/api/org/sources` — org-admin CRUD for all image sources (kind='external',
 * kind='base', kind='repo') and their bake history. Replaces the split
 * `routes/image-catalog.ts` (kind='external') and `routes/prebuilds.ts`
 * (kind='repo') route files.
 *
 * All routes require `requireOrgAdmin`.
 *
 * kind='repo' rows are auto-created when a session binds a repo (Task 15).
 * POST rejects kind='repo' with 400 and kind='base' with 403: the one base
 * an org has is the seeded full base. Built-in rows (`builtInSourceKind`)
 * refuse PATCH and DELETE with 403, and POST refuses their reserved names
 * with 409. POST /:id/bake delegates to SourceService and maps its typed
 * errors to HTTP codes.
 *
 * SETUP_COMMANDS validation: reject entries that contain newlines or carriage
 * returns (Dockerfile structural-injection guard, Task 15 spec review).
 */
import { RegistryCapacityError } from "../bakes/registry-health.js";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { isScratchRequestError, isValidSandboxCpu, parseResourceQuantity, sandboxCpuRange, validateScratchRequest } from "@valet/shared";
import { recordScratchRefused } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { imageSources, bakes, type ImageSourceRow } from "../schema/index.js";
import { GitHubAuthError } from "../services/github-tokens.js";
import {
  AnonymousImageBakesDisabledError,
  GitHubApiError,
  PrebuildConfigNotFoundError,
  PrebuildUnavailableError,
  builtInSourceKind,
  isReservedSourceName,
} from "../bakes/source-service.js";
import type { ApiError, ListSourceChangesResponse, PendingSourceChangeResponse, SourceChangeSummary } from "../wire/types.js";
import {
  approveSourceChange,
  imageSourceApprovalMode,
  listSourceChanges,
  patchTouchesContent,
  rejectSourceChange,
  requestSourceChange,
  SourceChangeRefusal,
  withdrawSourceChange,
  type SourceChangeRequestRow,
} from "../bakes/source-change-requests.js";
import { auditRequest } from "./_admin-audit.js";
import { commandDigest, diffFields, displayUrl } from "../services/admin-audit.js";

/** The audit summary of a pending change: what the requester asked for.
 * `externalRef` is shown as a display URL, and setup commands as a digest. */
function changeAuditView(row: SourceChangeRequestRow): Record<string, unknown> {
  const p = row.payload;
  const view: Record<string, unknown> = { changeId: row.id, change: row.action, requestedBy: row.requestedBy };
  for (const field of ["name", "parentId", "pullSecretName", "enabled", "schedule"]) {
    if (p[field] !== undefined) view[field] = p[field];
  }
  if (p.setupCommands !== undefined) view.setupCommands = commandDigest(p.setupCommands);
  if (typeof p.externalRef === "string") view.externalRef = displayUrl(p.externalRef);
  return view;
}

/** Audits a stored change request. A request is a high-risk signal on its
 * own: another admin should look at it before anyone approves. */
async function auditChangeRequested(c: Context<AppEnv>, row: SourceChangeRequestRow): Promise<void> {
  await auditRequest(c, {
    action: "image_source.change_requested",
    targetType: "image_source",
    targetId: row.sourceId ?? row.id,
    targetName: row.sourceName,
    changes: changeAuditView(row),
    alert: row.action === "create" ? "image_source_created" : "image_source_changed",
  });
}

/** The audited fields of an image source. `externalRef` can embed registry credentials, so it is shown as a display URL; setup commands are a digest. */
function auditView(row: ImageSourceRow) {
  return {
    name: row.name,
    enabled: row.enabled,
    schedule: row.schedule,
    externalRef: row.externalRef ? displayUrl(row.externalRef) : null,
    setupCommands: commandDigest(row.setupCommands),
    parentId: row.parentId,
    sandboxResources: row.sandboxResources,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newExternalSourceId(): string {
  return `img_${randomUUID()}`;
}

/**
 * Refusal for a write to a built-in image source (`builtInSourceKind`). The
 * status is 403, not 409: the request is valid and the caller is an org
 * admin, but no API caller may do this, and no change of state makes a retry
 * succeed. Code and the deploy configuration own these rows, because their
 * setup commands and image refs run in every later bake and sandbox.
 */
function builtInRefusal(name: string): ApiError {
  return { error: `${name} is a built-in image source. Change it in code or the deploy configuration, not through the API.` };
}

/** Fetch a source owned by the org, optionally filtered by kind. Returns
 * undefined if not found or kind doesn't match — callers return 404. */
async function getOwnedSource(
  db: AppEnv["Variables"]["providers"]["db"],
  id: string,
  orgId: string,
  kind?: ImageSourceRow["kind"],
): Promise<ImageSourceRow | undefined> {
  const conditions = [eq(imageSources.id, id), eq(imageSources.orgId, orgId)];
  if (kind) conditions.push(eq(imageSources.kind, kind));
  const rows = await db
    .select()
    .from(imageSources)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}

/** Validate that all entries in a setupCommands array are single-line strings.
 * Returns an error message string if invalid, undefined if valid. */
function validateSetupCommands(cmds: unknown): string | undefined {
  if (!Array.isArray(cmds)) return "setupCommands must be an array";
  for (const cmd of cmds) {
    if (typeof cmd !== "string") return "setupCommands entries must be strings";
    if (/[\r\n]/.test(cmd)) {
      return "Setup commands must be single lines. Split multi-line steps into separate commands.";
    }
  }
  return undefined;
}

function changeSummary(row: SourceChangeRequestRow): SourceChangeSummary {
  return {
    id: row.id,
    action: row.action,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    payload: row.payload,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
  };
}

/** Maps a refused change request to its HTTP status; rethrows anything else. */
function refusalResponse(c: Context<AppEnv>, err: unknown) {
  if (err instanceof SourceChangeRefusal) {
    const body: ApiError = { error: err.message };
    return c.json(body, err.status);
  }
  throw err;
}

// ── Admin router (/api/org/sources) ──────────────────────────────────────────

export const sourcesRouter = new Hono<AppEnv>();

sourcesRouter.get("/health", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  c.header("Cache-Control", "no-store");
  return c.json(await c.var.providers.prebuildService.health(c.var.user.orgId));
});


// GET / — list all sources for the org (all kinds)
sourcesRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { db, prebuildService } = c.var.providers;
  const rows = await db
    .select()
    .from(imageSources)
    .where(eq(imageSources.orgId, c.var.user.orgId));
  // One summary per source keeps collapsed rows current without loading build logs.
  const latestBakes = await db
    .selectDistinctOn([bakes.sourceId], {
      sourceId: bakes.sourceId,
      status: bakes.status,
      createdAt: bakes.createdAt,
    })
    .from(bakes)
    .innerJoin(imageSources, eq(bakes.sourceId, imageSources.id))
    .where(eq(imageSources.orgId, c.var.user.orgId))
    .orderBy(bakes.sourceId, desc(bakes.createdAt), desc(bakes.id));
  const latestBySource = new Map(latestBakes.map(({ sourceId, ...bake }) => [sourceId, bake]));
  return c.json({
    sources: rows.map((source) => ({
      ...source,
      builtIn: builtInSourceKind(source) !== null,
      latestBake: latestBySource.get(source.id) ?? null,
    })),
    builderAvailable: prebuildService.builderBackend !== null,
  });
});

sourcesRouter.get("/queue", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  return c.json(await c.var.providers.prebuildService.listBakeQueue(c.var.user.orgId));
});

sourcesRouter.patch("/queue", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.bakeIds) || !body.bakeIds.every((id): id is string => typeof id === "string")) {
    return c.json({ error: "Send bakeIds as an array of bake IDs. Refresh the queue before you retry." }, 400);
  }
  if (!await c.var.providers.prebuildService.reorderBakeQueue(c.var.user.orgId, body.bakeIds)) {
    return c.json({ error: "The queue changed or cannot be reordered. Refresh the queue, then retry with all waiting bake IDs." }, 409);
  }
  return c.json({ ok: true });
});

// POST / — create kind='external' or kind='base'; reject kind='repo'
sourcesRouter.post("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const { kind } = body;

  if (kind === "repo") {
    return c.json(
      {
        error:
          "Repository sources are created automatically when a session binds the repo. Submit kind='external' or kind='base' instead.",
      },
      400,
    );
  }

  const { db } = c.var.providers;
  const now = Date.now();

  if (kind === "external") {
    if (
      typeof body.name !== "string" ||
      body.name.trim() === "" ||
      typeof body.externalRef !== "string" ||
      body.externalRef.trim() === ""
    ) {
      return c.json({ error: "Provide name and externalRef when you create an external image source." }, 400);
    }
    if (isReservedSourceName(body.name)) {
      return c.json({ error: `${body.name.trim()} is a reserved built-in image source name. Choose a different name.` }, 409);
    }
    const pullSecretName =
      typeof body.pullSecretName === "string" && body.pullSecretName.trim() !== ""
        ? body.pullSecretName
        : null;
    const row = {
      id: newExternalSourceId(),
      orgId: c.var.user.orgId,
      kind: "external" as const,
      parentId: null,
      name: body.name as string,
      externalRef: body.externalRef as string,
      pullSecretName,
      setupCommands: null,
      // profile is only meaningful for kind='base' rows; null for external.
      profile: null,
      repoHost: null,
      repoFullName: null,
      cloneUrl: null,
      schedule: "nightly" as const,
      enabled: true,
      lastBoundAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (imageSourceApprovalMode() === "required") {
      try {
        const pending = await requestSourceChange(db, { orgId: row.orgId, requestedBy: c.var.user.id, action: "create", sourceName: row.name, payload: row });
        await auditChangeRequested(c, pending);
        const resp: PendingSourceChangeResponse = { pendingChange: changeSummary(pending) };
        return c.json(resp, 202);
      } catch (err) {
        return refusalResponse(c, err);
      }
    }
    await db.insert(imageSources).values(row);
    await auditRequest(c, {
      action: "image_source.create",
      targetType: "image_source",
      targetId: row.id,
      targetName: row.name,
      changes: { kind: row.kind, externalRef: displayUrl(row.externalRef), pullSecretName: row.pullSecretName },
      alert: "image_source_created",
    });
    return c.json({ source: row }, 201);
  }

  // Single image lineage: the one base an org has is the seeded full base,
  // and code owns it. A second base would be refused by the one-base-per-
  // (org, profile) index, and a first one before seeding would shadow the
  // built-in row.
  if (kind === "base") {
    return c.json(builtInRefusal("The full base image"), 403);
  }

  return c.json({ error: "kind must be 'external' or 'base'" }, 400);
});

// GET /changes — image-source changes that wait for a second admin
sourcesRouter.get("/changes", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const rows = await listSourceChanges(c.var.providers.db, c.var.user.orgId);
  const resp: ListSourceChangesResponse = {
    changes: rows.map(changeSummary),
    approval: imageSourceApprovalMode(),
  };
  return c.json(resp);
});

// POST /changes/:changeId/approve — a different org admin applies the change
sourcesRouter.post("/changes/:changeId/approve", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  try {
    const { request, source } = await approveSourceChange(c.var.providers.db, {
      orgId: c.var.user.orgId,
      approverId: c.var.user.id,
      id: c.req.param("changeId"),
    });
    await auditRequest(c, {
      action: request.action === "create" ? "image_source.create" : "image_source.update",
      targetType: "image_source",
      targetId: source.id,
      targetName: source.name,
      changes: { ...changeAuditView(request), approvedBy: c.var.user.id },
      alert: request.action === "create" ? "image_source_created" : builtInSourceKind(source) !== null ? "builtin_image_changed" : "image_source_changed",
    });
    return c.json({ change: changeSummary(request), source });
  } catch (err) {
    return refusalResponse(c, err);
  }
});

// POST /changes/:changeId/reject — another org admin declines the change
sourcesRouter.post("/changes/:changeId/reject", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const body: unknown = await c.req.json().catch(() => ({}));
  const note = isRecord(body) && typeof body.note === "string" ? body.note : undefined;
  try {
    const row = await rejectSourceChange(c.var.providers.db, {
      orgId: c.var.user.orgId,
      userId: c.var.user.id,
      id: c.req.param("changeId"),
      note,
    });
    await auditRequest(c, {
      action: "image_source.change_rejected",
      targetType: "image_source",
      targetId: row.sourceId ?? row.id,
      targetName: row.sourceName,
      changes: { changeId: row.id, requestedBy: row.requestedBy, note: row.decisionNote },
    });
    return c.json({ change: changeSummary(row) });
  } catch (err) {
    return refusalResponse(c, err);
  }
});

// DELETE /changes/:changeId — the requester withdraws a pending change
sourcesRouter.delete("/changes/:changeId", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  try {
    const row = await withdrawSourceChange(c.var.providers.db, {
      orgId: c.var.user.orgId,
      userId: c.var.user.id,
      id: c.req.param("changeId"),
    });
    await auditRequest(c, {
      action: "image_source.change_withdrawn",
      targetType: "image_source",
      targetId: row.sourceId ?? row.id,
      targetName: row.sourceName,
      changes: { changeId: row.id },
    });
    return c.json({ change: changeSummary(row) });
  } catch (err) {
    return refusalResponse(c, err);
  }
});

// PATCH /:id — kind-scoped field updates
sourcesRouter.patch("/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, scratchCaps } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "source not found" }, 404);

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  // Built-in rows accept no field changes. Content fields change what every
  // later bake and sandbox runs. `enabled: false` on the full base or
  // stock-full breaks sandbox starts. `schedule: "off"` stops the nightly
  // rebake that carries a deploy pin change into the base image.
  if (builtInSourceKind(existing) && Object.keys(body).length > 0) {
    return c.json(builtInRefusal(existing.name), 403);
  }

  const patch: Partial<typeof imageSources.$inferInsert> = { updatedAt: Date.now() };

  // shared fields — all kinds
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    patch.enabled = body.enabled;
  }
  if (body.schedule !== undefined) {
    if (body.schedule !== "nightly" && body.schedule !== "off") {
      return c.json({ error: "schedule must be 'nightly' or 'off'" }, 400);
    }
    patch.schedule = body.schedule;
  }

  // profile is immutable — reject any attempt to change it.
  if (body.profile !== undefined) {
    return c.json({ error: "profile is immutable and cannot be changed after creation" }, 400);
  }

  // kind-scoped fields
  if (body.sandboxResources !== undefined) {
    if (existing.kind !== "repo") {
      return c.json({ error: "Set sandboxResources on a repository source only." }, 400);
    }
    const resources = body.sandboxResources;
    if (resources === null) {
      patch.sandboxResources = null;
    } else {
      if (!isRecord(resources) || Array.isArray(resources)) {
        return c.json({ error: "Set sandboxResources to an object with optional cpu, memory, and scratch fields, or null to clear defaults." }, 400);
      }
      if (Object.keys(resources).some((field) => field !== "cpu" && field !== "memory" && field !== "scratch")) {
        return c.json({ error: "Remove unsupported sandboxResources fields. Use cpu, memory, and scratch only." }, 400);
      }
      const parsed: NonNullable<ImageSourceRow["sandboxResources"]> = {};
      if (resources.cpu !== undefined) {
        if (!isValidSandboxCpu(resources.cpu)) {
          return c.json({ error: `sandboxResources.cpu must be ${sandboxCpuRange()}. Set it to a value such as 2 or 0.5.` }, 400);
        }
        parsed.cpu = resources.cpu;
      }
      if (resources.memory !== undefined) {
        const memory = typeof resources.memory === "string" ? resources.memory.trim() : "";
        const quantity = parseResourceQuantity(memory);
        if (quantity === null || quantity <= 0) {
          return c.json({ error: "Set sandboxResources.memory to a positive Kubernetes quantity, such as 8Gi or 500Mi." }, 400);
        }
        parsed.memory = memory;
      }
      if (resources.scratch !== undefined) {
        try {
          parsed.scratch = validateScratchRequest(resources.scratch, "saved", scratchCaps);
        } catch (err) {
          if (isScratchRequestError(err)) {
            recordScratchRefused("saved", err.reason);
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }
      }
      patch.sandboxResources = Object.keys(parsed).length > 0 ? parsed : null;
    }
  }

  if (body.setupCommands !== undefined) {
    if (existing.kind !== "base") {
      return c.json({ error: "setupCommands can only be set on kind='base' sources" }, 400);
    }
    const cmdErr = validateSetupCommands(body.setupCommands);
    if (cmdErr) return c.json({ error: cmdErr }, 400);
    patch.setupCommands = body.setupCommands as string[];
  }

  if (body.externalRef !== undefined) {
    if (existing.kind !== "external") {
      return c.json({ error: "externalRef can only be set on kind='external' sources" }, 400);
    }
    if (typeof body.externalRef !== "string" || body.externalRef.trim() === "") {
      return c.json({ error: "externalRef must be a non-empty string" }, 400);
    }
    patch.externalRef = body.externalRef;
  }

  if (body.parentId !== undefined) {
    if (existing.kind !== "repo") {
      return c.json({ error: "parentId can only be set on kind='repo' sources" }, 400);
    }
    if (body.parentId !== null && typeof body.parentId !== "string") {
      return c.json({ error: "parentId must be a string or null" }, 400);
    }
    // Validate parentId belongs to same org (if provided)
    if (body.parentId !== null) {
      const parent = await getOwnedSource(db, body.parentId as string, c.var.user.orgId);
      if (!parent) return c.json({ error: "parentId not found in this org" }, 400);
      if (parent.kind !== "base" && parent.kind !== "external") {
        return c.json({ error: "parentId must reference a kind='base' or kind='external' source" }, 400);
      }
    }
    patch.parentId = body.parentId as string | null;
  }

  // A patch that changes what the image runs or builds FROM waits for a
  // second org admin (`bakes/source-change-requests.ts`).
  if (imageSourceApprovalMode() === "required" && patchTouchesContent(patch)) {
    const { updatedAt: _requestedAt, ...payload } = patch;
    try {
      const pending = await requestSourceChange(db, {
        orgId: c.var.user.orgId,
        requestedBy: c.var.user.id,
        action: "update",
        source: existing,
        sourceName: existing.name,
        payload,
      });
      await auditChangeRequested(c, pending);
      const resp: PendingSourceChangeResponse = { pendingChange: changeSummary(pending) };
      return c.json(resp, 202);
    } catch (err) {
      return refusalResponse(c, err);
    }
  }

  await db.update(imageSources).set(patch).where(eq(imageSources.id, id));
  const updated = await getOwnedSource(db, id, c.var.user.orgId);
  if (updated) {
    const changes = diffFields(auditView(existing), auditView(updated),
      ["name", "enabled", "schedule", "externalRef", "setupCommands", "parentId", "sandboxResources"]);
    // What a bake runs or builds FROM is the risky part. A toggle of
    // `enabled` or `schedule` on a custom source is recorded without an alert.
    const buildInputChanged = (existing.externalRef ?? null) !== (updated.externalRef ?? null) ||
      "setupCommands" in changes || "parentId" in changes;
    const builtIn = builtInSourceKind(existing) !== null;
    await auditRequest(c, {
      action: "image_source.update",
      targetType: "image_source",
      targetId: id,
      targetName: updated.name,
      changes: builtIn ? { ...changes, builtIn: true } : changes,
      alert: builtIn && Object.keys(changes).length > 0 ? "builtin_image_changed" : buildInputChanged ? "image_source_changed" : null,
    });
  }
  return c.json({ source: updated });
});

// DELETE /:id — kind-aware delete; bakes CASCADE
sourcesRouter.delete("/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "source not found" }, 404);
  if (builtInSourceKind(existing)) return c.json(builtInRefusal(existing.name), 403);

  await db.delete(imageSources).where(eq(imageSources.id, id));
  const builtIn = builtInSourceKind(existing) !== null;
  await auditRequest(c, {
    action: "image_source.delete",
    targetType: "image_source",
    targetId: id,
    targetName: existing.name,
    changes: { kind: existing.kind, ...(builtIn ? { builtIn: true } : {}) },
    alert: builtIn ? "builtin_image_changed" : null,
  });
  return c.json({ ok: true });
});

// POST /:id/bake — manual build trigger (admin)
sourcesRouter.post("/:id/bake", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, prebuildService } = c.var.providers;
  const id = c.req.param("id");
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "source not found" }, 404);

  try {
    const row = await prebuildService.startBuild(id);
    await auditRequest(c, {
      action: "bake.start",
      targetType: "bake",
      targetId: row.id,
      targetName: source.name,
      changes: { sourceId: id, sourceKind: source.kind },
    });
    return c.json({ bake: row }, 202);
  } catch (err) {
    if (err instanceof AnonymousImageBakesDisabledError) return c.json({ error: err.message }, 403);
    if (err instanceof RegistryCapacityError) return c.json({ error: err.message, code: err.code }, 503);
    if (err instanceof PrebuildUnavailableError) return c.json({ error: err.message }, 409);
    if (err instanceof PrebuildConfigNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof GitHubAuthError) return c.json({ error: err.message }, 502);
    // A GitHub-side failure (404 on a private repo without a credential, rate
    // limit, 5xx) is an upstream error, not an api bug. The 502 keeps the
    // status and path details, then names the action the administrator can take.
    if (err instanceof GitHubApiError) {
      const response: ApiError = {
        error: `${err.message}. Retry the build. If it fails again, check GitHub access and status.`,
      };
      return c.json(response, 502);
    }
    throw err;
  }
});

// GET /:id/bakes — bake history (admin)
sourcesRouter.get("/:id/bakes", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "source not found" }, 404);

  const rows = await db
    .select({
      id: bakes.id,
      sourceId: bakes.sourceId,
      identityHash: bakes.identityHash,
      commitSha: bakes.commitSha,
      imageRef: bakes.imageRef,
      status: bakes.status,
      builderBackend: bakes.builderBackend,
      error: bakes.error,
      logTail: bakes.logTail,
      startedAt: bakes.startedAt,
      finishedAt: bakes.finishedAt,
      createdAt: bakes.createdAt,
    })
    .from(bakes)
    .where(eq(bakes.sourceId, id))
    .orderBy(desc(bakes.createdAt));
  return c.json({ bakes: rows });
});
