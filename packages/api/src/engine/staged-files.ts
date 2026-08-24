/**
 * Staged-files core (docs/specs/2026-08-23-staged-files-design.md): the
 * target-path rules, the snapshot row shape `computeSpec` consumes, and the
 * apply closure `buildPrepSteps` pairs with each `staged:<id>` step.
 *
 * A staged file binds a session to a payload and a workspace-relative
 * target path. Producers (skill activation, parent-to-child shares) write
 * `session_staged_files` rows; materialization happens here.
 */
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { BlobStore, PrepStep, Sandbox } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { sessionStagedFiles } from "../schema/index.js";

/** In-sandbox workspace root. Every staged target resolves under it. */
export const WORKSPACE_ROOT = "/workspace";
/** Scratch directory for bundle tarballs, inside the workspace so the
 * docker provider's host-side write and the container-side exec see the
 * same file. */
export const STAGED_TMP_DIR = "/workspace/.valet/tmp";
/** Default directory for shares whose caller named no target. */
export const SHARED_DIR = ".valet/shared";
/** Root for skill resource bundles: `<SKILLS_DIR>/<skill-name>/`. */
export const SKILLS_DIR = ".valet/skills";

/** What `ResolveSnapshot.stagedFiles` carries: one row of
 * `session_staged_files`, already validated at insert time. */
export interface StagedFileSnap {
  id: string;
  origin: "skill" | "share";
  /** Workspace-relative target. For a bundle, the directory to unpack into. */
  targetPath: string;
  kind: "file" | "bundle";
  /** Blob store key, or null when the payload is inline. */
  blobKey: string | null;
  /** Inline payload text, or null when the payload is in the blob store. */
  inlineContent: string | null;
  /** SHA-256 of the payload. Feeds the step hash (INV-4). */
  contentHash: string;
}

/**
 * Validates and normalizes a staged target path (INV-2). Accepts a
 * workspace-relative path or a `/workspace/...` absolute one, and returns
 * the workspace-relative form. Rejects everything that would resolve
 * outside `/workspace`: other absolute paths, and `..` traversal.
 */
export function validateTargetPath(raw: string): string {
  let path = raw.trim();
  if (path === WORKSPACE_ROOT || path === `${WORKSPACE_ROOT}/`) {
    throw new Error(`Target path is empty. Name a file or directory under ${WORKSPACE_ROOT}.`);
  }
  if (path.startsWith(`${WORKSPACE_ROOT}/`)) {
    path = path.slice(WORKSPACE_ROOT.length + 1);
  } else if (posix.isAbsolute(path)) {
    throw new Error(
      `Target path "${raw}" is outside the workspace. Use a path under ${WORKSPACE_ROOT}.`,
    );
  }
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === "") {
    throw new Error(`Target path is empty. Name a file or directory under ${WORKSPACE_ROOT}.`);
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(
      `Target path "${raw}" escapes the workspace. Use a path under ${WORKSPACE_ROOT}.`,
    );
  }
  return normalized;
}

/** The absolute in-sandbox path a staged row materializes at. */
export function stagedAbsolutePath(row: Pick<StagedFileSnap, "targetPath">): string {
  return posix.join(WORKSPACE_ROOT, row.targetPath);
}

/** Buffers a blob-store stream. Payload sizes are capped at stage time
 * (design decision 8), so buffering is bounded. */
async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function loadPayload(row: StagedFileSnap, blobs: BlobStore | undefined): Promise<Uint8Array> {
  if (row.inlineContent !== null) return new TextEncoder().encode(row.inlineContent);
  if (row.blobKey === null) {
    throw new Error(`staged file ${row.id} has neither inline content nor a blob key`);
  }
  if (!blobs) {
    throw new Error(
      `staged file ${row.id} needs the blob store, but none is wired. Configure the API blob store.`,
    );
  }
  const blob = await blobs.get(row.blobKey);
  if (!blob) {
    throw new Error(
      `staged file ${row.id}: blob ${row.blobKey} is missing from the blob store. Push the file again.`,
    );
  }
  return readAll(blob.data);
}

/**
 * Builds the apply closure for one staged row. `kind: file` writes the
 * payload at the target (inline text via writeFile, blob bytes via
 * writeBinary). `kind: bundle` writes the tarball into STAGED_TMP_DIR and
 * unpacks it with one exec. A failure throws so `attachment.reconcile`
 * records the step as unapplied and retries at the next window.
 */
export function buildStagedStep(
  spec: { id: string; hash: string; critical: boolean },
  row: StagedFileSnap,
  deps: { blobs?: BlobStore },
): PrepStep {
  return {
    id: spec.id,
    hash: spec.hash,
    critical: spec.critical,
    async apply(sandbox: Sandbox) {
      const target = stagedAbsolutePath(row);
      if (row.kind === "file") {
        const payload = await loadPayload(row, deps.blobs);
        await sandbox.mkdir(posix.dirname(target));
        if (row.inlineContent !== null) {
          await sandbox.writeFile(target, row.inlineContent);
        } else {
          await sandbox.writeBinary(target, payload);
        }
        return;
      }
      // Bundle: tarball through the workspace, then one exec to unpack.
      const payload = await loadPayload(row, deps.blobs);
      const tmp = `${STAGED_TMP_DIR}/staged-${row.id}.tgz`;
      await sandbox.mkdir(STAGED_TMP_DIR);
      await sandbox.writeBinary(tmp, payload);
      const cmd = `mkdir -p '${target}' && tar xzf '${tmp}' -C '${target}' && rm -f '${tmp}'`;
      const result = await sandbox.exec(cmd);
      if (result.exitCode !== 0) {
        throw new Error(
          `staged bundle ${row.id} failed to unpack into ${target}: ${result.stderr || result.stdout}`,
        );
      }
    },
  };
}

// ── Staging service ───────────────────────────────────────────────────────

/** A file payload at or under this size, when it decodes as UTF-8 text,
 * stays inline in the row. Everything else goes to the blob store. */
export const INLINE_MAX_BYTES = 16 * 1024;
/** Cap for one share (design decision 8). */
export const SHARE_MAX_BYTES = 256 * 1024 * 1024;

export interface StageDeps {
  db: AppDb;
  blobs?: BlobStore;
  now?: () => number;
}

export interface StageArgs {
  sessionId: string;
  origin: "skill" | "share";
  originKey: string;
  targetPath: string;
  kind: "file" | "bundle";
  payload: Uint8Array;
}

function isInlineText(payload: Uint8Array): boolean {
  if (payload.byteLength > INLINE_MAX_BYTES) return false;
  if (payload.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upserts one staged file for a session: payload into the blob store (or
 * inline when small text), row into `session_staged_files`. The UNIQUE
 * (session_id, target_path) index makes a re-push an update in place —
 * the newest payload owns the path, under the same row id and blob key.
 *
 * The blob is written BEFORE the row, so a crash between the two leaves
 * an orphan blob, never a row that points at nothing.
 */
export async function stageForSession(deps: StageDeps, args: StageArgs): Promise<StagedFileSnap> {
  const targetPath = validateTargetPath(args.targetPath);
  const contentHash = createHash("sha256").update(args.payload).digest("hex");
  const inline = args.kind === "file" && isInlineText(args.payload);

  const existing = await deps.db
    .select({ id: sessionStagedFiles.id, blobKey: sessionStagedFiles.blobKey })
    .from(sessionStagedFiles)
    .where(
      and(
        eq(sessionStagedFiles.sessionId, args.sessionId),
        eq(sessionStagedFiles.targetPath, targetPath),
      ),
    )
    .limit(1);
  const id = existing[0]?.id ?? `sf_${randomUUID()}`;
  const blobKey = inline ? null : `staged/${args.sessionId}/${id}`;

  if (!inline) {
    if (!deps.blobs) {
      throw new Error(
        "Staging this payload needs the blob store, but none is wired. Configure the API blob store.",
      );
    }
    await deps.blobs.put(blobKey!, args.payload);
  }

  const now = (deps.now ?? Date.now)();
  const values = {
    id,
    sessionId: args.sessionId,
    origin: args.origin,
    originKey: args.originKey,
    targetPath,
    kind: args.kind,
    blobKey,
    inlineContent: inline ? new TextDecoder().decode(args.payload) : null,
    contentHash,
    sizeBytes: args.payload.byteLength,
    createdAt: now,
    updatedAt: now,
  };
  await deps.db
    .insert(sessionStagedFiles)
    .values(values)
    .onConflictDoUpdate({
      target: [sessionStagedFiles.sessionId, sessionStagedFiles.targetPath],
      set: {
        origin: values.origin,
        originKey: values.originKey,
        kind: values.kind,
        blobKey: values.blobKey,
        inlineContent: values.inlineContent,
        contentHash: values.contentHash,
        sizeBytes: values.sizeBytes,
        updatedAt: now,
      },
    });

  // A payload that moved from blob to inline leaves its old blob behind.
  if (inline && existing[0]?.blobKey && deps.blobs) {
    await deps.blobs.delete(existing[0].blobKey).catch(() => {});
  }

  return {
    id,
    origin: values.origin,
    targetPath,
    kind: values.kind,
    blobKey,
    inlineContent: values.inlineContent,
    contentHash,
  };
}

/** Reads a session's staged rows for `ResolveSnapshot.stagedFiles`, in
 * insertion order so step order is stable across reconciles. */
export async function loadStagedFiles(db: AppDb, sessionId: string): Promise<StagedFileSnap[]> {
  const rows = await db
    .select()
    .from(sessionStagedFiles)
    .where(eq(sessionStagedFiles.sessionId, sessionId))
    .orderBy(asc(sessionStagedFiles.createdAt), asc(sessionStagedFiles.id));
  return rows.map((row) => ({
    id: row.id,
    origin: row.origin,
    targetPath: row.targetPath,
    kind: row.kind,
    blobKey: row.blobKey,
    inlineContent: row.inlineContent,
    contentHash: row.contentHash,
  }));
}

/** Removes a session's staged rows and their blobs. Called on session
 * delete. Blob deletes are best-effort: an orphan blob is storage waste,
 * never wrong behavior. */
export async function deleteStagedForSession(
  db: AppDb,
  blobs: BlobStore | undefined,
  sessionId: string,
): Promise<void> {
  const rows = await db
    .select({ blobKey: sessionStagedFiles.blobKey })
    .from(sessionStagedFiles)
    .where(eq(sessionStagedFiles.sessionId, sessionId));
  await db.delete(sessionStagedFiles).where(eq(sessionStagedFiles.sessionId, sessionId));
  if (!blobs) return;
  for (const row of rows) {
    if (row.blobKey) await blobs.delete(row.blobKey).catch(() => {});
  }
}

/**
 * Writes a skill's bundled resources into the session's sandbox (so the
 * files exist this turn) and stages one row per resource (so reconcile
 * re-materializes them after a sandbox replacement). Returns the absolute
 * in-sandbox skill root. Sessions without a db get the write-through only
 * (design decision 7's exception).
 *
 * Resource paths run through validateTargetPath, so a path that escapes
 * the workspace throws even though plugin skills are trusted input.
 */
export async function materializeSkillResources(
  deps: { db?: AppDb; blobs?: BlobStore; now?: () => number },
  skill: { name: string; resources?: Array<{ path: string; data: Uint8Array }> },
  ctx: { sessionId: string; sandbox: Sandbox },
): Promise<string> {
  const rootRel = `${SKILLS_DIR}/${skill.name}`;
  const rootAbs = posix.join(WORKSPACE_ROOT, rootRel);
  let hasScripts = false;
  for (const resource of skill.resources ?? []) {
    const rel = validateTargetPath(`${rootRel}/${resource.path}`);
    if (!rel.startsWith(`${rootRel}/`)) {
      throw new Error(
        `Skill resource path "${resource.path}" escapes the workspace skill root. Use a path relative to the skill directory.`,
      );
    }
    if (resource.path.startsWith("scripts/")) hasScripts = true;
    const abs = posix.join(WORKSPACE_ROOT, rel);
    await ctx.sandbox.mkdir(posix.dirname(abs));
    await ctx.sandbox.writeBinary(abs, resource.data);
    if (deps.db) {
      await stageForSession(
        { db: deps.db, blobs: deps.blobs, now: deps.now },
        {
          sessionId: ctx.sessionId,
          origin: "skill",
          originKey: skill.name,
          targetPath: rel,
          kind: "file",
          payload: resource.data,
        },
      );
    }
  }
  // Best-effort executable bit for scripts/ — some providers' writeBinary
  // lands 0644, and "run scripts/x.sh" is the whole point of the bundle.
  if (hasScripts) {
    await ctx.sandbox.exec(`chmod -R a+rx '${rootAbs}/scripts'`).catch(() => {});
  }
  return rootAbs;
}

/**
 * Reads one path out of a sandbox for staging (the parent side of a
 * share). A file comes back as its bytes; a directory becomes a gzipped
 * tarball, built through the workspace tmp dir so the docker provider's
 * container-side exec and host-side read see the same file.
 */
export async function snapshotFromSandbox(
  sandbox: Sandbox,
  fromPath: string,
): Promise<{ kind: "file" | "bundle"; payload: Uint8Array }> {
  const rel = validateTargetPath(fromPath);
  const abs = posix.join(WORKSPACE_ROOT, rel);
  let stat: { isFile: boolean; isDirectory: boolean };
  try {
    stat = await sandbox.stat(abs);
  } catch {
    throw new Error(
      `Path "${fromPath}" was not found in the sandbox workspace. Name a file or directory under ${WORKSPACE_ROOT}.`,
    );
  }
  if (stat.isFile) {
    return { kind: "file", payload: await sandbox.readBinary(abs) };
  }
  if (!stat.isDirectory) {
    throw new Error(`Path "${fromPath}" is neither a file nor a directory.`);
  }
  const tmp = `${STAGED_TMP_DIR}/snap-${randomUUID()}.tgz`;
  const cmd = `mkdir -p '${STAGED_TMP_DIR}' && tar czf '${tmp}' -C '${abs}' .`;
  const result = await sandbox.exec(cmd);
  if (result.exitCode !== 0) {
    throw new Error(
      `Snapshot of "${fromPath}" failed: ${result.stderr || result.stdout}`,
    );
  }
  try {
    return { kind: "bundle", payload: await sandbox.readBinary(tmp) };
  } finally {
    await sandbox.exec(`rm -f '${tmp}'`).catch(() => {});
  }
}
