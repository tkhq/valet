/**
 * The `object-store` WorkspaceStore backend over the S3 API
 * (workspace-persistence spec, Part 04). Runs against any S3-compatible
 * endpoint (AWS, MinIO, R2 — INV-4) through a configurable endpoint with
 * path-style addressing.
 *
 * Two consumers share this module:
 *   - the Node-side `WorkspaceStore` interface (Part 01) — used by the
 *     MinIO integration suite and any future non-k8s wiring;
 *   - the kubernetes provider, which uses `latest()` for the policy
 *     kernel's inputs, `presignCheckpointPuts()` for the in-pod checkpoint
 *     script, and `pruneCheckpoints()` after a commit.
 * Both write and read the identical object layout via the shared key
 * helpers in `@valet/engine`.
 */
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { createGzip, createGunzip } from "node:zlib";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  checkpointDataKey,
  checkpointManifestKey,
  latestPointerKey,
  validateWorkspaceRef,
  workspaceObjectPrefix,
  type CheckpointManifest,
  type WorkspaceRef,
  type WorkspaceStore,
} from "@valet/engine";
import type { ObjectStoreConfig } from "./workspace-persistence.js";
import type { CheckpointUploadUrls } from "./workspace-scripts.js";

/** How long a presigned checkpoint PUT stays valid. Generous relative to a
 * large upload; the URLs are minted immediately before the in-pod exec. */
const PRESIGN_EXPIRY_SECONDS = 30 * 60;

const CHECKPOINT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/** Time-prefixed, collision-resistant, URL/shell-safe checkpoint id. */
export function makeCheckpointId(createdAtMs: number): string {
  return `ck-${Math.floor(createdAtMs).toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Counts POSIX ustar entries flowing through a plain (uncompressed) tar
 * stream. Pure block-walk: 512-byte header, size at offset 124 (octal),
 * then ceil(size/512) data blocks; a zero-filled header block ends the
 * archive. */
export class TarEntryCounter extends Transform {
  entryCount = 0;
  private pending: Buffer = Buffer.alloc(0);
  private skipBlocks = 0;
  private done = false;

  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (!this.done && this.pending.length >= 512) {
      const block = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (this.skipBlocks > 0) {
        this.skipBlocks--;
        continue;
      }
      if (block.every((b) => b === 0)) {
        this.done = true;
        break;
      }
      const typeflag = block[156];
      // Count real entries; skip pax/gnu metadata records (x, g, L, K).
      const meta = typeflag === 0x78 || typeflag === 0x67 || typeflag === 0x4c || typeflag === 0x4b;
      if (!meta) this.entryCount++;
      const sizeField = block.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
      const size = sizeField === "" ? 0 : Number.parseInt(sizeField, 8);
      this.skipBlocks = Number.isFinite(size) && size > 0 ? Math.ceil(size / 512) : 0;
    }
    cb(null, chunk);
  }
}

/** Byte counter for the uploaded (post-gzip) stream. */
class ByteCounter extends Transform {
  bytes = 0;
  override _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    cb(null, chunk);
  }
}

/** The slice of the object-store backend the kubernetes provider's
 * checkpoint path drives — narrow so provider tests fake it without S3. */
export interface WorkspaceCheckpointStore {
  latest(ref: WorkspaceRef): Promise<CheckpointManifest | null>;
  presignCheckpointPuts(ref: WorkspaceRef, checkpointId: string): Promise<CheckpointUploadUrls>;
  pruneCheckpoints(ref: WorkspaceRef, latestCheckpointId: string): Promise<void>;
}

export interface ObjectStoreClientOpts {
  /** Injected client (tests). Wins over `credentials`. */
  client?: S3Client;
  /** Static credentials for the api-side client. Absent → the SDK default
   * chain (env, shared config, IRSA web identity on EKS). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class ObjectStoreWorkspaceStore implements WorkspaceStore, WorkspaceCheckpointStore {
  private readonly cfg: ObjectStoreConfig;
  private readonly client: S3Client;

  constructor(cfg: ObjectStoreConfig, opts: ObjectStoreClientOpts = {}) {
    this.cfg = cfg;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const clientCfg: S3ClientConfig = {
        region: cfg.region,
        // Path-style so one code path serves AWS and MinIO (INV-4).
        forcePathStyle: true,
        ...(cfg.endpoint !== "" ? { endpoint: cfg.endpoint } : {}),
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      };
      this.client = new S3Client(clientCfg);
    }
  }

  async latest(ref: WorkspaceRef): Promise<CheckpointManifest | null> {
    validateWorkspaceRef(ref);
    const pointer = await this.getBody(latestPointerKey(this.cfg.prefix, ref));
    if (pointer === null) return null;
    const checkpointId = pointer.trim();
    if (!CHECKPOINT_ID_PATTERN.test(checkpointId)) {
      throw new Error(
        `workspace ${ref.workspaceId}: latest pointer holds an invalid checkpoint id ${JSON.stringify(checkpointId)}`,
      );
    }
    const manifestBody = await this.getBody(checkpointManifestKey(this.cfg.prefix, ref, checkpointId));
    if (manifestBody === null) return null;
    return parseManifest(manifestBody, checkpointId);
  }

  async checkpoint(
    ref: WorkspaceRef,
    tar: NodeJS.ReadableStream,
    meta: { createdAtMs: number },
  ): Promise<CheckpointManifest> {
    validateWorkspaceRef(ref);
    const checkpointId = makeCheckpointId(meta.createdAtMs);
    const counter = new TarEntryCounter();
    const bytes = new ByteCounter();
    const source = tar as Readable;
    const body = this.cfg.gzip
      ? source.pipe(counter).pipe(createGzip()).pipe(bytes)
      : source.pipe(counter).pipe(bytes);

    // INV-2 commit order: data first, manifest second, latest pointer last.
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: checkpointDataKey(this.cfg.prefix, ref, checkpointId),
        Body: body,
      },
    });
    await upload.done();

    const manifest: CheckpointManifest = {
      checkpointId,
      createdAtMs: meta.createdAtMs,
      sizeBytes: bytes.bytes,
      entryCount: counter.entryCount,
    };
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: checkpointManifestKey(this.cfg.prefix, ref, checkpointId),
        Body: JSON.stringify(manifest),
        ContentType: "application/json",
      }),
    );
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: latestPointerKey(this.cfg.prefix, ref),
        Body: checkpointId,
      }),
    );
    // Retention (Part 04): prune beyond the newest N after a successful
    // commit; a pruning failure never fails the checkpoint.
    try {
      await this.pruneCheckpoints(ref, checkpointId);
    } catch (err) {
      console.error(`workspace ${ref.workspaceId}: checkpoint prune failed (non-fatal):`, err);
    }
    return manifest;
  }

  async restore(ref: WorkspaceRef): Promise<NodeJS.ReadableStream | null> {
    validateWorkspaceRef(ref);
    const manifest = await this.latest(ref);
    if (manifest === null) return null;
    const key = checkpointDataKey(this.cfg.prefix, ref, manifest.checkpointId);
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
    const body = res.Body;
    if (!(body instanceof Readable)) {
      throw new Error(`checkpoint ${manifest.checkpointId}: object body is not a Node stream`);
    }
    return this.cfg.gzip ? body.pipe(createGunzip()) : body;
  }

  async purge(ref: WorkspaceRef): Promise<void> {
    validateWorkspaceRef(ref);
    await this.deleteByPrefix(workspaceObjectPrefix(this.cfg.prefix, ref));
  }

  /** Presigned PUT URLs for one in-pod checkpoint commit (spec 05.3). Each
   * URL is scoped to exactly one object key under this workspace's own
   * prefix, so the sandbox never holds credentials that could reach
   * another tenant's objects (INV-3, INV-6). */
  async presignCheckpointPuts(ref: WorkspaceRef, checkpointId: string): Promise<CheckpointUploadUrls> {
    validateWorkspaceRef(ref);
    const sign = (key: string) =>
      getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
        expiresIn: PRESIGN_EXPIRY_SECONDS,
      });
    const [dataUrl, manifestUrl, latestUrl] = await Promise.all([
      sign(checkpointDataKey(this.cfg.prefix, ref, checkpointId)),
      sign(checkpointManifestKey(this.cfg.prefix, ref, checkpointId)),
      sign(latestPointerKey(this.cfg.prefix, ref)),
    ]);
    return { dataUrl, manifestUrl, latestUrl };
  }

  /** Deletes committed checkpoints beyond the newest `keepCheckpoints`,
   * never the one `latest` points to. Newness orders by the time-prefixed
   * checkpoint id (make- and script-minted ids share the format). */
  async pruneCheckpoints(ref: WorkspaceRef, latestCheckpointId: string): Promise<void> {
    const keep = Math.max(1, this.cfg.keepCheckpoints);
    const base = workspaceObjectPrefix(this.cfg.prefix, ref);
    const checkpointsPrefix = `${base}checkpoints/`;
    const ids = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.cfg.bucket,
          Prefix: checkpointsPrefix,
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const cp of page.CommonPrefixes ?? []) {
        const id = cp.Prefix?.slice(checkpointsPrefix.length).replace(/\/$/, "");
        if (id) ids.add(id);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const ordered = [...ids].sort().reverse(); // ids are time-prefixed → newest first
    const excess = ordered.filter((id) => id !== latestCheckpointId).slice(keep - 1);
    for (const id of excess) {
      await this.deleteByPrefix(`${checkpointsPrefix}${id}/`);
    }
  }

  private async getBody(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return res.Body === undefined ? null : await res.Body.transformToString("utf8");
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  private async deleteByPrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.cfg.bucket, Delete: { Objects: keys } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

export function parseManifest(body: string, expectedId: string): CheckpointManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`checkpoint ${expectedId}: manifest.json is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`checkpoint ${expectedId}: manifest.json is not an object`);
  }
  const m = raw as Record<string, unknown>;
  const checkpointId = typeof m.checkpointId === "string" ? m.checkpointId : expectedId;
  const createdAtMs = typeof m.createdAtMs === "number" ? m.createdAtMs : 0;
  const sizeBytes = typeof m.sizeBytes === "number" ? m.sizeBytes : 0;
  const entryCount = typeof m.entryCount === "number" ? m.entryCount : 0;
  return { checkpointId, createdAtMs, sizeBytes, entryCount };
}

