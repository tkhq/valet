/**
 * A local stand-in for the Google Drive v3 API, so the folder scope and the
 * folder picker can be clicked through without a Google account.
 *
 * Point both halves at it and store any token on the credential:
 *
 *   GOOGLE_DRIVE_API_URL=http://127.0.0.1:47322/drive/v3   # api + plugin
 *   pnpm --filter @valet/api exec tsx scripts/drive-fixture.ts
 *
 * It holds one small tree in memory and answers the calls the plugin's
 * drive.* actions, the containment walk and the picker make: files.get
 * (including the `root` alias), files.list with the query terms the plugin
 * builds, create, copy, update (rename and re-parent), delete and export.
 * Docs and Sheets are not served: neither is part of the scope.
 *
 * Every request is logged, so a click-through shows which calls the scope
 * let reach Drive and which it refused before asking.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const PORT = Number(process.env.FIXTURE_PORT ?? 47322);
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";

interface Node {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  content: string;
  modifiedTime: string;
}

const ROOT_ID = "0ROOT";
const files = new Map<string, Node>();
let seq = 0;

function add(id: string, name: string, mimeType: string, parent: string | null, content = ""): Node {
  const node: Node = {
    id,
    name,
    mimeType,
    parents: parent ? [parent] : [],
    trashed: false,
    content,
    modifiedTime: new Date().toISOString(),
  };
  files.set(id, node);
  return node;
}

add(ROOT_ID, "My Drive", FOLDER, null);
add("fold-finance", "Finance", FOLDER, ROOT_ID);
add("fold-finance-2026", "2026", FOLDER, "fold-finance");
add("doc-budget", "Budget 2026", DOC, "fold-finance-2026", "Q1 12k, Q2 14k, Q3 15k.");
add("doc-invoices", "Invoices", DOC, "fold-finance", "Invoice 1, invoice 2.");
add("fold-eng", "Engineering", FOLDER, ROOT_ID);
add("doc-roadmap", "Roadmap", DOC, "fold-eng", "Ship the folder scope.");
add("fold-personal", "Personal", FOLDER, ROOT_ID);
add("doc-diary", "Diary", DOC, "fold-personal", "Nobody's business.");
add("doc-loose", "Loose note", DOC, ROOT_ID, "Sits in the root.");

function wire(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    mimeType: node.mimeType,
    parents: node.parents,
    trashed: node.trashed,
    modifiedTime: node.modifiedTime,
    createdTime: node.modifiedTime,
    webViewLink: `https://drive.example/${node.id}`,
    owners: [{ displayName: "Fixture Owner", emailAddress: "owner@example.com" }],
    shared: false,
  };
}

/** Enough of the Drive query language to serve what the plugin builds. */
function matches(node: Node, q: string): boolean {
  const clauses = q.split(/\s+and\s+/i);
  for (const clause of clauses) {
    const c = clause.trim().replace(/^\((.*)\)$/, "$1");
    if (/^trashed\s*=\s*false$/i.test(c)) {
      if (node.trashed) return false;
      continue;
    }
    const parent = /^'([^']+)'\s+in\s+parents$/i.exec(c);
    if (parent) {
      const wanted = parent[1] === "root" ? ROOT_ID : parent[1];
      if (!node.parents.includes(wanted)) return false;
      continue;
    }
    const mime = /^mimeType\s*=\s*'([^']+)'$/i.exec(c);
    if (mime) {
      if (node.mimeType !== mime[1]) return false;
      continue;
    }
    const mimeNot = /^mimeType\s*!=\s*'([^']+)'$/i.exec(c);
    if (mimeNot) {
      if (node.mimeType === mimeNot[1]) return false;
      continue;
    }
    // (name contains 'x' or fullText contains 'x'), or either alone.
    const terms = [...c.matchAll(/(name|fullText)\s+contains\s+'([^']*)'/gi)];
    if (terms.length > 0) {
      const hit = terms.some(([, field, needle]) => {
        const hay = field.toLowerCase() === "name" ? node.name : `${node.name} ${node.content}`;
        return hay.toLowerCase().includes(needle.toLowerCase());
      });
      if (!hit) return false;
      continue;
    }
    if (/^'me'\s+in\s+owners$/i.test(c) || /^sharedWithMe\s*=\s*true$/i.test(c)) continue;
    if (/^modifiedTime\s*>/i.test(c)) continue;
    console.log(`  (unhandled clause ignored: ${c})`);
  }
  return true;
}

const app = new Hono();
app.use("*", async (c, next) => {
  const q = c.req.query("q");
  console.log(`${new Date().toISOString()} ${c.req.method} ${c.req.path}${q ? `  q=${q}` : ""}`);
  await next();
});

const base = "/drive/v3";

app.get(`${base}/files`, (c) => {
  const q = c.req.query("q") ?? "";
  const pageSize = Number(c.req.query("pageSize") ?? 100);
  const list = [...files.values()].filter((n) => n.id !== ROOT_ID && matches(n, q)).slice(0, pageSize);
  return c.json({ files: list.map(wire) });
});

app.get(`${base}/files/:id`, (c) => {
  const id = c.req.param("id") === "root" ? ROOT_ID : c.req.param("id");
  const node = files.get(id);
  if (!node) return c.json({ error: { code: 404, message: "File not found" } }, 404);
  if (c.req.query("alt") === "media") return c.text(node.content);
  return c.json(wire(node));
});

app.get(`${base}/files/:id/export`, (c) => {
  const node = files.get(c.req.param("id"));
  if (!node) return c.json({ error: { code: 404, message: "File not found" } }, 404);
  return c.text(node.content);
});

app.post(`${base}/files`, async (c) => {
  const body = (await c.req.json()) as { name?: string; mimeType?: string; parents?: string[] };
  const parent = body.parents?.[0] ?? ROOT_ID;
  const node = add(`new-${++seq}`, body.name ?? "Untitled", body.mimeType ?? DOC, parent === "root" ? ROOT_ID : parent);
  return c.json(wire(node));
});

app.post(`${base}/files/:id/copy`, async (c) => {
  const source = files.get(c.req.param("id"));
  if (!source) return c.json({ error: { code: 404, message: "File not found" } }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; parents?: string[] };
  const parent = body.parents?.[0] ?? source.parents[0] ?? ROOT_ID;
  const node = add(`copy-${++seq}`, body.name ?? `Copy of ${source.name}`, source.mimeType, parent, source.content);
  return c.json(wire(node));
});

app.patch(`${base}/files/:id`, async (c) => {
  const node = files.get(c.req.param("id"));
  if (!node) return c.json({ error: { code: 404, message: "File not found" } }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; trashed?: boolean };
  if (typeof body.name === "string") node.name = body.name;
  if (typeof body.trashed === "boolean") node.trashed = body.trashed;
  const addParents = c.req.query("addParents");
  const removeParents = c.req.query("removeParents");
  if (removeParents) node.parents = node.parents.filter((p) => !removeParents.split(",").includes(p));
  if (addParents) node.parents = [...new Set([...node.parents, ...addParents.split(",")])];
  return c.json(wire(node));
});

app.delete(`${base}/files/:id`, (c) => {
  files.delete(c.req.param("id"));
  return c.body(null, 204);
});

app.notFound((c) => {
  console.log(`  (no handler: ${c.req.method} ${c.req.path})`);
  return c.json({ error: { code: 404, message: "Not served by the fixture" } }, 404);
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Drive fixture on http://127.0.0.1:${PORT}${base}`);
  console.log(`Tree: Finance/2026/Budget 2026, Finance/Invoices, Engineering/Roadmap, Personal/Diary, Loose note`);
});
