import type { PostSandboxGitPushRequest } from "../wire/types.js";

export const GIT_REPLAY_MAX_BODY_BYTES = 160 * 1024 * 1024;
export const GIT_REPLAY_MAX_DECODED_BYTES = 128 * 1024 * 1024;
export const GIT_REPLAY_MAX_OBJECTS = 10_000;
export const GIT_REPLAY_MAX_TREE_ENTRIES = 100_000;

export class GitReplayPayloadError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
  }
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function decodedBase64Bytes(value: string): number {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new GitReplayPayloadError("The signed replay contains invalid base64 object data. Recreate the push payload and retry.");
  }
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

interface GitReplayLimits {
  bodyBytes: number;
  decodedBytes: number;
  objects: number;
  treeEntries: number;
}

const DEFAULT_LIMITS: GitReplayLimits = {
  bodyBytes: GIT_REPLAY_MAX_BODY_BYTES,
  decodedBytes: GIT_REPLAY_MAX_DECODED_BYTES,
  objects: GIT_REPLAY_MAX_OBJECTS,
  treeEntries: GIT_REPLAY_MAX_TREE_ENTRIES,
};

/** Validate V1 replay shape and aggregate object budgets before host-side replay starts. */
export function validateGitReplayPayload(value: unknown, encodedBytes: number, limits: GitReplayLimits = DEFAULT_LIMITS): PostSandboxGitPushRequest {
  if (encodedBytes > limits.bodyBytes) {
    throw new GitReplayPayloadError(`The signed replay request exceeds ${limits.bodyBytes} encoded bytes. Split the push into smaller branches or commits.`, 413);
  }
  const body = record(value);
  if (!body) throw new GitReplayPayloadError("Send a JSON object with the signed replay data.");
  if (!string(body.repoFullName) || !string(body.targetRef) || !string(body.expectedRemoteSha)
    || (body.createRef !== undefined && typeof body.createRef !== "boolean")
    || (body.force !== undefined && typeof body.force !== "boolean")) {
    throw new GitReplayPayloadError("repoFullName, targetRef, expectedRemoteSha, and optional replay flags must use their documented types.");
  }
  const blobs = body.blobs === undefined ? [] : body.blobs;
  const trees = body.trees === undefined ? [] : body.trees;
  const lfsObjects = body.lfsObjects === undefined ? [] : body.lfsObjects;
  const commits = body.commits;
  if (!Array.isArray(blobs) || !Array.isArray(trees) || !Array.isArray(lfsObjects) || !Array.isArray(commits)) {
    throw new GitReplayPayloadError("Send blob, tree, LFS, and commit objects as arrays.");
  }
  const objectCount = blobs.length + trees.length + lfsObjects.length + commits.length;
  if (objectCount > limits.objects) {
    throw new GitReplayPayloadError(`The signed replay contains more than ${limits.objects} objects. Split the push into smaller branches or commits.`, 413);
  }

  let decodedBytes = 0;
  let treeEntryCount = 0;
  for (const value of blobs) {
    const blob = record(value);
    if (!blob || !string(blob.sha) || !string(blob.contentBase64)) throw new GitReplayPayloadError("Each replay blob must include sha and contentBase64 strings.");
    decodedBytes += decodedBase64Bytes(blob.contentBase64) + utf8Bytes(blob.sha);
  }
  for (const value of lfsObjects) {
    const object = record(value);
    if (!object || !string(object.oid) || !Number.isSafeInteger(object.size) || Number(object.size) < 0 || !string(object.contentBase64)) {
      throw new GitReplayPayloadError("Each replay LFS object must include an oid, a non-negative size, and contentBase64.");
    }
    const contentBytes = decodedBase64Bytes(object.contentBase64);
    if (contentBytes !== object.size) throw new GitReplayPayloadError(`LFS object ${object.oid} does not match its declared size. Recreate the push payload and retry.`);
    decodedBytes += contentBytes + utf8Bytes(object.oid);
  }
  for (const value of trees) {
    const tree = record(value);
    if (!tree || !string(tree.sha) || !Array.isArray(tree.entries)) throw new GitReplayPayloadError("Each replay tree must include a sha and entries array.");
    treeEntryCount += tree.entries.length;
    if (treeEntryCount > limits.treeEntries) {
      throw new GitReplayPayloadError(`The signed replay contains more than ${limits.treeEntries} tree entries. Split the push into smaller branches or commits.`, 413);
    }
    decodedBytes += utf8Bytes(tree.sha);
    for (const value of tree.entries) {
      const entry = record(value);
      if (!entry || !string(entry.path) || !string(entry.mode) || !["blob", "tree", "commit"].includes(String(entry.type)) || !string(entry.sha)) {
        throw new GitReplayPayloadError("Each replay tree entry must include path, mode, type, and sha strings.");
      }
      decodedBytes += utf8Bytes(entry.path) + utf8Bytes(entry.mode) + utf8Bytes(String(entry.type)) + utf8Bytes(entry.sha);
    }
  }
  for (const value of commits) {
    const commit = record(value);
    if (!commit || !string(commit.localSha) || !string(commit.message) || !string(commit.treeSha) || !Array.isArray(commit.parents) || !commit.parents.every(string)) {
      throw new GitReplayPayloadError("Each replay commit must include localSha, message, treeSha, and string parents.");
    }
    decodedBytes += utf8Bytes(commit.localSha) + utf8Bytes(commit.message) + utf8Bytes(commit.treeSha)
      + commit.parents.reduce((total: number, parent: string) => total + utf8Bytes(parent), 0);
  }
  if (decodedBytes > limits.decodedBytes) {
    throw new GitReplayPayloadError(`The signed replay exceeds ${limits.decodedBytes} decoded bytes. Split the push into smaller branches or commits.`, 413);
  }
  return {
    repoFullName: body.repoFullName,
    targetRef: body.targetRef,
    expectedRemoteSha: body.expectedRemoteSha,
    ...(body.createRef === undefined ? {} : { createRef: body.createRef }),
    ...(body.force === undefined ? {} : { force: body.force }),
    blobs: blobs as PostSandboxGitPushRequest["blobs"],
    trees: trees as PostSandboxGitPushRequest["trees"],
    lfsObjects: lfsObjects as PostSandboxGitPushRequest["lfsObjects"],
    commits: commits as PostSandboxGitPushRequest["commits"],
  };
}

/** Read a request body with both declared-length and streamed-byte enforcement. */
export async function readBoundedGitReplayJson(request: Request, maxBytes = GIT_REPLAY_MAX_BODY_BYTES): Promise<{ value: unknown; encodedBytes: number }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new GitReplayPayloadError("Send a valid Content-Length for the signed replay request.");
    if (length > maxBytes) throw new GitReplayPayloadError(`The signed replay request exceeds ${maxBytes} encoded bytes. Split the push into smaller branches or commits.`, 413);
  }
  if (!request.body) throw new GitReplayPayloadError("Send a valid Git push request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let encodedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      encodedBytes += value.byteLength;
      if (encodedBytes > maxBytes) {
        await reader.cancel();
        throw new GitReplayPayloadError(`The signed replay request exceeds ${maxBytes} encoded bytes. Split the push into smaller branches or commits.`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(encodedBytes);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, encodedBytes };
  } catch {
    throw new GitReplayPayloadError("Send a valid Git push request.");
  }
}
