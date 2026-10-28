import { createServer } from "node:http";
import { marked } from "marked";
import { pluginCatalogTools } from "@valet/engine";
import { imageCommentBody, withImageDeadline } from "./comment-images.js";
import { afterEach, expect, it, vi } from "vitest";
import { githubPlugin } from "./actions.js";
import { fakeActionContext } from "../test-helpers/action-context.js";

const octokitOptions = vi.hoisted(() => vi.fn());
const throttleTest = vi.hoisted(() => ({ real: false }));

// Fast semantic tests skip throttle clocks. The concurrency, batch, and queue tests opt into the real limiter.
vi.mock("octokit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("octokit")>();
  return { ...actual, Octokit: class extends actual.Octokit {
    constructor(options?: ConstructorParameters<typeof actual.Octokit>[0]) {
      octokitOptions(options);
      super(throttleTest.real ? options : { ...options, throttle: { enabled: false }, retry: { enabled: false } });
    }
  } };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: (min: number) => min };
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const args = { owner: "acme", repo: "widgets", issueNumber: 42 };
const action = githubPlugin.actions.find((a) => a.id === "github.create_comment");
if (!action) throw new Error("Missing create_comment action");
const comment = action;
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; vi.unstubAllEnvs(); vi.useRealTimers(); throttleTest.real = false; });

async function fixture(options: {
  existing?: boolean; refStatus?: number; commentStatus?: number;
  previousStatus?: number; unrelated?: boolean; pullStatus?: number; enforceFastForward?: boolean; deleteOnPatch?: boolean; refMessage?: string; stall?: "blob" | "comment";
} = {}) {
  const calls: { method: string; path: string; body: unknown; auth?: string }[] = [];
  let commits = 0;
  let currentSha = options.existing ? "previous-sha" : undefined;
  let deleteOnPatch = options.deleteOnPatch ?? false;
  const parents = new Map<string, string | undefined>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const payload = typeof body === "object" && body !== null ? body : {};
    const path = decodeURIComponent(req.url ?? "");
    calls.push({ method: req.method ?? "", path, body, auth: req.headers.authorization });
    let status = 200;
    let response: object = {};
    let message = "Not Found";
    if ((options.stall === "blob" && path.endsWith("/git/blobs")) || (options.stall === "comment" && path.endsWith("/comments"))) return;
    if (path.endsWith("/pulls/42")) {
      status = options.pullStatus ?? 200;
      message = status === 403 ? "Resource not accessible by integration" : "Not Found";
      response = { base: { repo: { html_url: "https://github.com/acme/widgets" } } };
    } else if (path.endsWith("/git/blobs")) response = { sha: "blob-sha" };
    else if (path.endsWith("/git/trees")) response = { sha: "tree-sha" };
    else if (path.includes("/git/ref/")) {
      status = currentSha ? 200 : 404;
      response = { object: { sha: currentSha } };
    } else if (path.endsWith("/git/commits")) {
      const sha = `commit-${++commits}`;
      const list = "parents" in payload && Array.isArray(payload.parents) ? payload.parents : [];
      parents.set(sha, typeof list[0] === "string" ? list[0] : undefined);
      response = { sha };
    } else if (path.includes("/git/commits/")) {
      status = options.previousStatus ?? 200;
      response = { message: options.unrelated ? "Valet-Assets: pr-420" : "Attach images for PR #42\n\nValet-Assets: pr-42" };
    } else if (path.includes("/git/refs")) {
      const sha = "sha" in payload && typeof payload.sha === "string" ? payload.sha : "";
      if (deleteOnPatch && req.method === "PATCH") { currentSha = undefined; deleteOnPatch = false; status = 422; message = "Reference does not exist"; }
      const collision = options.enforceFastForward && (req.method === "POST" ? currentSha !== undefined : parents.get(sha) !== currentSha);
      if (status !== 422) status = options.refStatus ?? (collision ? 422 : 200);
      if (options.refStatus) message = options.refMessage ?? "Repository rule violation: ref update denied";
      if (collision && message !== "Reference does not exist") message = req.method === "POST" ? "Reference already exists" : "Update is not a fast forward";
      if (status === 200) { currentSha = sha; }
    } else if (path.endsWith("/comments")) {
      status = options.commentStatus ?? 201;
      message = "Validation Failed: body is too long";
      response = { id: 123, html_url: "https://github.com/acme/widgets/pull/42#issuecomment-123", body };
    } else status = 404;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status >= 400 ? { message } : response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  vi.stubEnv("GITHUB_API_URL", `http://127.0.0.1:${address.port}`);
  close = () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()); });
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

it("stores an orphan snapshot and uses SHA-pinned blob URLs", async () => {
  const calls = await fixture();
  const result = await comment.execute({ ...args, body: "Before", images: [
    { path: "/workspace/any image.png", alt: "view ](evil)", caption: "A <b>caption</b>" },
    { path: "relative/generated.png", caption: "Same bytes" },
  ] }, context(png, "installation-token"));
  expect(result.success).toBe(true);
  expect(octokitOptions).toHaveBeenLastCalledWith(expect.objectContaining({ throttle: expect.objectContaining({ id: expect.stringMatching(/^valet-comment-images-[a-f0-9]{64}$/) }), retry: { enabled: false } }));
  expect(result.data).toMatchObject({ id: 123, assetsRef: "refs/valet/pr-assets/42", assetsCommit: "commit-1", imageUrls: [
    expect.stringMatching(/^https:\/\/github.com\/acme\/widgets\/blob\/commit-1\/pr-42\/[a-f0-9]{64}\.png\?raw=true$/), expect.any(String),
  ] });
  expect(calls.filter((c) => c.path.endsWith("/git/blobs"))).toHaveLength(1);
  expect(calls.find((c) => c.path.endsWith("/git/blobs"))?.body).toEqual({ content: png.toString("base64"), encoding: "base64" });
  expect(calls.find((c) => c.path.endsWith("/git/trees"))?.body).toEqual({ tree: [expect.objectContaining({ mode: "100644", type: "blob", sha: "blob-sha" })] });
  expect(calls.find((c) => c.path.endsWith("/git/commits"))?.body).toMatchObject({ parents: [], tree: "tree-sha", message: "Attach images for PR #42\n\nValet-Assets: pr-42" });
  expect(calls.find((c) => c.path.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/valet/pr-assets/42", sha: "commit-1" });
  expect(calls.at(-1)?.body).toMatchObject({ body: expect.stringMatching(/^!\[view &#93;[\s\S]*\n\nBefore$/) });
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
  expect(calls.at(-1)?.body).toMatchObject({ body: expect.stringMatching(/^!\[Image 1/) });
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
  expect(result.error).toContain(status === 404 ? "Images work only on pull requests" : "connected user's repository role");
  expect(result.error).toContain(status === 404 ? "Not Found" : "Resource not accessible by integration");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

it("exposes recovery Markdown through the actual engine call_tool failure text", async () => {
  const calls = await fixture({ commentStatus: 422 });
  const originalBody = "Deployment warning: do not roll back.\n```text\nlog";
  const tool = pluginCatalogTools({ plugins: [githubPlugin] }).find((t) => t.name === "call_tool");
  if (!tool) throw new Error("Missing call_tool");
  const ctx = context();
  ctx.policyResolver = { resolve: async () => ({ mode: "allow", provenance: { source: "risk_default", baseMode: "allow" } }) };
  const result = await tool.execute({ tool_id: "github.create_comment", params: { ...args, body: originalBody, images: [{ path: "image" }] }, summary: "Attach images" }, ctx);
  expect(result.ok).toBe(false);
  expect(result.text).toContain("Shorten the comment");
  expect(result.text).toContain("omit images");
  const recovery = result.text.split("omit images to avoid another upload:\n\n")[1];
  expect(calls.at(-1)?.body).toEqual({ body: recovery });
  expect(recovery?.endsWith(originalBody)).toBe(true);
  expect(result.text).toMatch(/!\[.*\]\(https:\/\/github.com\/acme\/widgets\/blob\/commit-1\/pr-42\/[a-f0-9]{64}\.png\?raw=true\)/);
});

it("reports ruleset rejection without retrying it as contention", async () => {
  const calls = await fixture({ existing: true, refStatus: 422 });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.error).toContain("Repository rule violation: ref update denied");
  expect(result.error).toContain("Ask a repository admin");
  expect(result.error).not.toContain("Concurrent");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  expect(calls.some((c) => c.path.endsWith("/comments"))).toBe(false);
});

it.each([false, true])("refuses an unrelated or unreadable existing assets commit (unrelated=%s)", async (unrelated) => {
  const calls = await fixture({ existing: true, unrelated, previousStatus: unrelated ? 200 : 404 });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/Ask|Grant/);
  expect(calls.some((c) => c.path.endsWith("/git/commits") || c.path.includes("/git/refs") || c.path.endsWith("/comments"))).toBe(false);
});


it.each([4, 6])("publishes %s concurrent batches under enforced fast-forward semantics", async (count) => {
  throttleTest.real = true;
  const calls = await fixture({ enforceFastForward: true });
  const start = performance.now();
  const timings: number[] = [];
  const results = await Promise.all(Array.from({ length: count }, async () => {
    const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context(png, `concurrency-${count}`));
    timings.push(Math.round(performance.now() - start));
    return result;
  }));
  console.log(`Real throttle ${count}-way completion ms: ${timings.join(", ")}`);
  expect(results.map((result) => result.success)).toEqual(Array(count).fill(true));
  expect(calls.filter((c) => c.path.endsWith("/comments"))).toHaveLength(count);
  expect(calls.filter((c) => c.path.endsWith("/git/commits")).slice(1).some((c) => typeof c.body === "object" && c.body !== null && "parents" in c.body && Array.isArray(c.body.parents) && c.body.parents.length === 1)).toBe(true);
  expect(calls.filter((c) => c.method === "PATCH").every((c) => typeof c.body === "object" && c.body !== null && "force" in c.body && c.body.force === false)).toBe(true);
  expect(calls.filter((c) => c.path.includes("/git/ref")).every((c) => c.path.endsWith("/valet/pr-assets/42") || c.path.endsWith("/git/refs"))).toBe(true);
}, 125_000);

it.each(["~~~", "```", "    indented", "---", "- x", "1. x", "# heading", "> quote", "~~strike~~", "@org/team", "https://example.com", "<img src=x>"])("renders inert caption and alt text with GFM: %s", (text) => {
  const markdown = imageCommentBody(undefined, [{ path: "one", alt: text, caption: text }, { path: "two" }], ["https://example.com/one.png", "https://example.com/two.png"]);
  // marked is a GFM proxy, not GitHub's sanitizer or mention parser. Live renderer evidence is in the spec.
  const html = marked.parse(markdown, { gfm: true, async: false });
  expect(html.match(/<img /g)).toHaveLength(2);
  expect(html).not.toMatch(/<(?:a|pre|hr|ul|ol|li|h[1-6]|blockquote|del)\b/);
  expect(html).toContain("<code>");
  expect(html).toContain('<img src="https://example.com/two.png"');
  const paragraph = html.match(/<p><code>(.*?)<\/code><\/p>/)?.[1];
  expect(paragraph?.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))).toBe(text);
});

it("names the session requirement when a workflow has no sandbox", async () => {
  const calls = await fixture();
  const ctx = context();
  ctx.sandbox.stat = async () => { throw new Error("sandbox unavailable in workflow action invocation"); };
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, ctx);
  expect(result.error).toContain("Images need a session sandbox");
  expect(calls).toHaveLength(0);
});

it.each(["AbortError", "TimeoutError"])("reports a pre-aborted session signal correctively: %s", async (name) => {
  const calls = await fixture();
  const ctx = context();
  const controller = new AbortController();
  controller.abort(new DOMException("Session ended", name)); ctx.signal = controller.signal;
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, ctx);
  expect(result.success).toBe(false);
  expect(result.error).toBe("Image attachment was cancelled. Retry from an active session if the images are still needed.");
  expect(calls).toHaveLength(0);
});


it("recreates a ref deleted between reading and PATCH", async () => {
  const calls = await fixture({ existing: true, deleteOnPatch: true, enforceFastForward: true });
  expect((await comment.execute({ ...args, images: [{ path: "image" }] }, context())).success).toBe(true);
  expect(calls.filter((c) => c.path.endsWith("/git/refs") && c.method === "POST")).toHaveLength(1);
});

it.each(["Reference name must start with refs/heads or refs/tags", "Invalid tree SHA"])("reports non-rule storage 422 accurately: %s", async (message) => {
  await fixture({ refStatus: 422, refMessage: message });
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, context());
  expect(result.error).toContain(message);
  expect(result.error).toContain("Correct the fields");
  expect(result.error).not.toContain("repository admin");
});

it("accepts ten 1000-character ASCII captions without duplicating them into alt text", async () => {
  await fixture();
  const caption = "a".repeat(1000);
  const result = await comment.execute({ ...args, images: Array.from({ length: 10 }, () => ({ path: "image", caption })) }, context());
  expect(result.success).toBe(true);
  expect(result.data).toMatchObject({ activityText: "Attached 10 image(s)." });
  const body = imageCommentBody(undefined, [{ path: "image", caption }], ["https://example.test/image.png"]);
  expect(body.match(/a{1000}/g)).toHaveLength(1);
});

const stalls: ("blob" | "comment")[] = ["blob", "comment"];
it.each(stalls)("bounds the whole operation at 120 seconds when %s stalls", async (stall) => {
  const calls = await fixture({ stall });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = comment.execute({ ...args, images: [{ path: "image" }] }, context());
  await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith(stall === "blob" ? "/git/blobs" : "/comments"))).toBe(true));
  await vi.advanceTimersByTimeAsync(120_000);
  const result = await pending;
  expect(result.error).toContain("exceeded 120 seconds");
  expect(result.error?.includes("omit images")).toBe(stall === "comment");
});

it("bounds even an unabortable queued task and aborts its signal", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const pending = withImageDeadline(context(), (ctx) => { signal = ctx.signal; return new Promise<never>(() => {}); }).catch((err: unknown) => err);
  await vi.advanceTimersByTimeAsync(120_000);
  const error = await pending;
  expect(error).toBeInstanceOf(Error);
  expect(signal?.aborted).toBe(true);
});


it.each(["```text\nlog", "~~~text\nlog", "<!-- hidden", "<details>\n<summary>Hidden</summary>\nlog"])("renders images before an open body container: %s", (body) => {
  const markdown = imageCommentBody(body, [{ path: "one", caption: "Visible caption" }, { path: "two" }], ["https://example.com/one.png", "https://example.com/two.png"]);
  expect(markdown.endsWith(`\n\n${body}`)).toBe(true);
  const html = marked.parse(markdown, { gfm: true, async: false });
  expect(html.match(/<img /g)).toHaveLength(2);
  const container = html.search(/<(?:pre|details)\b|<!--/);
  if (container >= 0) expect(html.indexOf('<img src="https://example.com/two.png"')).toBeLessThan(container);
});


it("completes a distinct ten-image batch through the real throttle", async () => {
  throttleTest.real = true;
  const calls = await fixture();
  const ctx = context(png, "ten-image-token");
  ctx.sandbox.readBinary = async (path) => Buffer.concat([png, Buffer.from(path)]);
  const start = performance.now();
  const result = await comment.execute({ ...args, images: Array.from({ length: 10 }, (_, i) => ({ path: `image-${i}` })) }, ctx);
  console.log(`Real throttle ten-image completion ms: ${Math.round(performance.now() - start)}`);
  expect(result.success).toBe(true);
  expect(calls.filter((c) => c.path.endsWith("/git/blobs"))).toHaveLength(10);
}, 125_000);

it("returns the plain corrective error for missing image credentials", async () => {
  const calls = await fixture();
  const ctx = context();
  ctx.credentials.get = async () => null;
  const result = await comment.execute({ ...args, images: [{ path: "image" }] }, ctx);
  expect(result.error).toBe("Missing GitHub access token. Connect the GitHub integration in Settings.");
  expect(calls).toHaveLength(0);
});

it("immediately rejects an abort while a real throttled write is queued", async () => {
  throttleTest.real = true;
  const calls = await fixture();
  const actual = await vi.importActual<typeof import("octokit")>("octokit");
  const token = "queued-abort-token";
  const { createHash } = await import("node:crypto");
  const client = new actual.Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL,
    throttle: { id: `valet-comment-images-${createHash("sha256").update(token).digest("hex")}`, onRateLimit: () => false, onSecondaryRateLimit: () => false }, retry: { enabled: false },
  });
  await client.request("POST /repos/{owner}/{repo}/git/blobs", { owner: args.owner, repo: args.repo, content: "", encoding: "base64" });
  const ctx = context(png, token);
  const controller = new AbortController(); ctx.signal = controller.signal;
  const pending = comment.execute({ ...args, images: [{ path: "image" }] }, ctx);
  await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith("/pulls/42"))).toBe(true));
  const start = performance.now(); controller.abort();
  const result = await pending;
  expect(performance.now() - start).toBeLessThan(250);
  expect(result.error).toContain("cancelled");
  // Octokit cannot cancel its queued noop reservation. When it releases, fetch must not write.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
});


it("bounds stalled credential resolution before storage", async () => {
  vi.useFakeTimers();
  const ctx = context();
  ctx.credentials.get = () => new Promise<never>(() => {});
  const pending = comment.execute({ ...args, images: [{ path: "image" }] }, ctx);
  await vi.advanceTimersByTimeAsync(120_000);
  expect((await pending).error).toContain("exceeded 120 seconds");
  expect(ctx.sandbox.readBinary).not.toHaveBeenCalled();
});

it("does not queue unrelated token or ordinary writes behind an image token", async () => {
  throttleTest.real = true;
  await fixture();
  const actual = await vi.importActual<typeof import("octokit")>("octokit");
  const { createHash } = await import("node:crypto");
  const token = "isolation-token";
  const options = { auth: token, baseUrl: process.env.GITHUB_API_URL, retry: { enabled: false },
    throttle: { id: `valet-comment-images-${createHash("sha256").update(token).digest("hex")}`, onRateLimit: () => false, onSecondaryRateLimit: () => false },
  };
  const busy = new actual.Octokit(options);
  const route = "POST /repos/{owner}/{repo}/git/blobs";
  const params = { owner: args.owner, repo: args.repo, content: "", encoding: "base64" };
  const queued = Promise.all(Array.from({ length: 3 }, () => busy.request(route, params)));
  const start = performance.now();
  const otherToken = new actual.Octokit({ ...options, throttle: { ...options.throttle, id: "valet-comment-images-other-token" } });
  const ordinary = new actual.Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL, retry: { enabled: false } });
  await Promise.all([otherToken.request(route, params), ordinary.request(route, params)]);
  expect(performance.now() - start).toBeLessThan(750);
  await queued;
});
