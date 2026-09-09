// Local stand-in for api.github.com so content sync can mirror a repository
// without a public repo. Serves every file under ./repo as `fixture/team-workflows`
// (and any other owner/name; the path is ignored). The commit sha is the
// sha256 of the file set, so editing a file is a "push".
//
// Run from packages/api so hono resolves:
//   cd packages/api && npx tsx <this file>
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.env.FIXTURE_REPO_DIR ?? new URL("./repo/", import.meta.url).pathname;
const PORT = Number(process.env.FIXTURE_PORT ?? 47321);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function snapshot(): { sha: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const p of walk(ROOT).sort()) files[relative(ROOT, p)] = readFileSync(p, "utf8");
  const sha = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  return { sha, files };
}

const blobSha = (content: string) =>
  `blob-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12)}`;

const app = new Hono();
const calls: string[] = [];
app.use("*", async (c, next) => {
  calls.push(`${c.req.method} ${c.req.path}`);
  console.log(`${new Date().toISOString()} ${c.req.method} ${c.req.path}${c.req.query("ref") ? ` ref=${c.req.query("ref")}` : ""}`);
  await next();
});

app.get("/repos/:owner/:repo", (c) => c.json({ default_branch: "main", full_name: `${c.req.param("owner")}/${c.req.param("repo")}` }));

app.get("/repos/:owner/:repo/commits/:ref", (c) => {
  const { sha } = snapshot();
  return c.json({ sha, commit: { tree: { sha: `tree-${sha}` } } });
});

app.get("/repos/:owner/:repo/git/trees/:sha", (c) => {
  const { sha, files } = snapshot();
  return c.json({
    sha: `tree-${sha}`,
    truncated: false,
    tree: Object.entries(files).map(([path, content]) => ({
      path,
      type: "blob",
      mode: "100644",
      sha: blobSha(content),
    })),
  });
});

app.get("/repos/:owner/:repo/contents/*", (c) => {
  const prefix = `/repos/${c.req.param("owner")}/${c.req.param("repo")}/contents/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length));
  const { files } = snapshot();
  const content = files[path];
  if (typeof content !== "string") return c.json({ message: "Not Found" }, 404);
  return c.json({
    type: "file",
    encoding: "base64",
    path,
    content: Buffer.from(content, "utf8").toString("base64"),
    sha: blobSha(content),
  });
});

app.get("/_calls", (c) => c.json(calls));
app.all("*", (c) => {
  console.log(`UNHANDLED ${c.req.method} ${c.req.path}`);
  return c.json({ message: "Not Found" }, 404);
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`github fixture on http://127.0.0.1:${PORT} serving ${ROOT} (sha ${snapshot().sha})`);
});
