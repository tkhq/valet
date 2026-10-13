import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { githubPlugin } from "./actions.js";
import { fakeActionContext } from "../test-helpers/action-context.js";

// Octokit spaces write requests by one second, including loopback requests.
vi.setConfig({ testTimeout: 20_000 });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const args = { owner: "acme", repo: "widgets", issueNumber: 42 };
const action = githubPlugin.actions.find((a) => a.id === "github.create_comment");
if (!action) throw new Error("Missing create_comment action");
const comment = action;
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.unstubAllEnvs(); });

async function fixture(options: {
  existing?: boolean; conflict?: boolean; refStatus?: number; commentStatus?: number;
  previousStatus?: number; unrelated?: boolean; pullStatus?: number; private?: boolean; branch?: string; defaultBranch?: string;
} = {}) {
  const calls: { method: string; path: string; body: unknown; auth?: string }[] = [];
  let existing = options.existing ?? false;
  let commits = 0;
  let conflict = options.conflict ?? false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const path = decodeURIComponent(req.url ?? "");
    calls.push({ method: req.method ?? "", path, body, auth: req.headers.authorization });
    let status = 200;
    let response: object = {};
    if (path.endsWith("/pulls/42")) {
      status = options.pullStatus ?? 200;
      response = { head: { ref: options.branch ?? "feature" }, base: { ref: "main", repo: {
        html_url: "https://github.com/acme/widgets", default_branch: options.defaultBranch ?? "main", private: options.private ?? false,
      } } };
    } else if (path.endsWith("/git/blobs")) response = { sha: "blob-sha" };
    else if (path.endsWith("/git/trees")) response = { sha: "tree-sha" };
    else if (path.includes("/git/ref/")) {
      status = existing ? 200 : 404;
      response = { object: { sha: "previous-sha" } };
    } else if (path.endsWith("/git/commits")) response = { sha: `commit-${++commits}` };
    else if (path.includes("/git/commits/")) {
      status = options.previousStatus ?? 200;
      response = { message: options.unrelated ? "Unrelated work" : "Attach images for PR #42\n\nChangelog: Attach PR comment images with Valet." };
    }
    else if (path.includes("/git/refs")) {
      status = options.refStatus ?? (conflict ? 422 : 200);
      conflict = false; existing = true;
    } else if (path.endsWith("/comments")) {
      status = options.commentStatus ?? 201;
      response = { id: 123, html_url: "https://github.com/acme/widgets/pull/42#issuecomment-123", body };
    } else status = 404;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status >= 400 ? { message: "remote-sensitive-detail" } : response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  vi.stubEnv("GITHUB_API_URL", `http://127.0.0.1:${address.port}`);
  close = () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return calls;
}

function context(bytes: Uint8Array = png, token = "user-token") {
  const ctx = fakeActionContext(token);
  ctx.sandbox.stat = vi.fn(async () => ({ isFile: true, isDirectory: false, size: bytes.byteLength }));
  ctx.sandbox.readBinary = vi.fn(async () => bytes);
  return ctx;
}

it("keeps body-only issue comments and their result unchanged", async () => {
  const calls = await fixture();
  const result = await comment.execute({ ...args, body: "original body" }, fakeActionContext("user-token"));
  expect(result).toEqual({ success: true, data: { id: 123, html_url: expect.any(String), body: {
    body: "original body",
  } } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "POST", path: "/repos/acme/widgets/issues/42/comments", body: { body: "original body" } });
});

it.each([false, true])("stores an orphan snapshot and uses SHA-pinned blob URLs (private=%s)", async (privateRepo) => {
  const calls = await fixture({ private: privateRepo });
  const result = await comment.execute({ ...args, body: "Before", images: [
    { path: "/workspace/any image.png", alt: "view ](evil)", caption: "A <b>caption</b>" },
    { path: "relative/generated.png", caption: "Same bytes" },
  ] }, context(png, "installation-token"));
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ id: 123, assetsBranch: "valet-pr-assets-42", assetsCommit: "commit-1", imageUrls: [
    expect.stringMatching(/^https:\/\/github.com\/acme\/widgets\/blob\/commit-1\/pr-42\/[a-f0-9]{64}\.png\?raw=true$/), expect.any(String),
  ] });
  expect(calls.filter((c) => c.path.endsWith("/git/blobs"))).toHaveLength(1);
  expect(calls.find((c) => c.path.endsWith("/git/blobs"))?.body).toEqual({ content: png.toString("base64"), encoding: "base64" });
  expect(calls.find((c) => c.path.endsWith("/git/trees"))?.body).toEqual({ tree: [expect.objectContaining({ mode: "100644", type: "blob", sha: "blob-sha" })] });
  expect(calls.find((c) => c.path.endsWith("/git/commits"))?.body).toMatchObject({ parents: [], tree: "tree-sha", message: expect.stringContaining("Changelog:") });
  expect(calls.find((c) => c.path.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/heads/valet-pr-assets-42", sha: "commit-1" });
  expect(calls.at(-1)?.body).toMatchObject({ body: expect.stringContaining("Before\n\n![view \\]\\(evil\\)](") });
  expect(calls.filter((c) => c.path.endsWith("/comments"))).toHaveLength(1);
  expect(calls.every((c) => c.auth === "token installation-token")).toBe(true);
});

it.each([
  ["jpeg", Buffer.from([255, 216, 255, 224])],
  ["gif", Buffer.from("GIF89a")],
  ["webp", Buffer.from("RIFF0000WEBP")],
])("detects %s bytes without trusting the filename, with no body", async (format, bytes) => {
  const calls = await fixture();
  const result = await comment.execute({ ...args, images: [{ path: "/workspace/no-extension" }] }, context(bytes));
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ imageUrls: [expect.stringContaining(format === "jpeg" ? ".jpg?raw=true" : `.${format}?raw=true`)] });
  expect(calls.at(-1)?.body).toMatchObject({ body: expect.stringMatching(/^!\[Image 1\]/) });
});

it.each([false, true])("preserves history and retries concurrent ref writes (conflict=%s)", async (conflict) => {
  const calls = await fixture({ existing: !conflict, conflict });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.success).toBe(true);
  const commits = calls.filter((c) => c.path.endsWith("/git/commits"));
  expect(commits.at(-1)?.body).toMatchObject({ parents: ["previous-sha"] });
  expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ force: false });
  expect(calls.filter((c) => c.path.endsWith("/comments"))).toHaveLength(1);
});

it.each(["directory", "missing", "oversize-stat", "oversize-read", "empty", "svg", "spoofed-png", "total", "count", "long-body"])("rejects %s before remote writes", async (failure) => {
  const calls = await fixture();
  const ctx = context();
  let images = [{ path: "image" }];
  if (failure === "directory") ctx.sandbox.stat = async () => ({ isFile: false, isDirectory: true, size: 1 });
  if (failure === "missing") ctx.sandbox.stat = async () => { throw new Error("missing"); };
  if (failure === "oversize-stat") ctx.sandbox.stat = async () => ({ isFile: true, isDirectory: false, size: 10 * 1024 * 1024 + 1 });
  if (failure === "oversize-read") ctx.sandbox.readBinary = async () => new Uint8Array(10 * 1024 * 1024 + 1);
  if (failure === "empty") ctx.sandbox.readBinary = async () => new Uint8Array();
  if (["svg", "spoofed-png"].includes(failure)) ctx.sandbox.readBinary = async () => Buffer.from("<svg/>");
  if (failure === "total") {
    const large = Buffer.alloc(8 * 1024 * 1024); png.copy(large);
    ctx.sandbox.readBinary = async () => large;
    images = Array.from({ length: 3 }, () => ({ path: "image" }));
  }
  if (failure === "count") images = [];
  const result = await comment.execute({ ...args, images, body: failure === "long-body" ? "x".repeat(60_001) : undefined }, ctx);
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Choose|Export|Reduce|Supply|Shorten/);
  expect(calls).toHaveLength(0);
});

it.each([403, 404])("names the fix when GitHub denies PR access (%s)", async (status) => {
  const calls = await fixture({ pullStatus: status });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Grant/);
  expect(result.error).not.toContain("remote-sensitive-detail");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

it.each(["head", "default"])("refuses to write a PR or default branch (%s)", async (branch) => {
  const calls = await fixture(branch === "head" ? { branch: "valet-pr-assets-42" } : { defaultBranch: "valet-pr-assets-42" });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.error).toContain("Rename");
  expect(calls).toHaveLength(1);
});

it("returns stored URLs after a comment failure without leaking remote errors", async () => {
  await fixture({ commentStatus: 403 });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.success).toBe(false);
  expect(result.data).toMatchObject({ imageUrls: [expect.any(String)], assetsCommit: "commit-1" });
  expect(result.error).toContain("omit images");
  expect(result.error).not.toContain("remote-sensitive-detail");
});

it("stops after three refused ref updates and posts no comment", async () => {
  const calls = await fixture({ existing: true, refStatus: 422 });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.error).toContain("Check branch rules");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(3);
  expect(calls.some((c) => c.path.endsWith("/comments"))).toBe(false);
});


it.each([false, true])("refuses an unrelated or unreadable existing assets commit (unrelated=%s)", async (unrelated) => {
  const calls = await fixture({ existing: true, unrelated, previousStatus: unrelated ? 200 : 404 });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Rename|Grant/);
  expect(calls.some((c) => c.path.endsWith("/git/commits") || c.path.includes("/git/refs") || c.path.endsWith("/comments"))).toBe(false);
});
