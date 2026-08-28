/**
 * `sec_*` ToolDefs (Valet Security spec §Tools) — both tool sets: the
 * runner set a `kind='security'` session drives its engagement with, and
 * the persona set a cell-claimed child session works under. Follows the
 * `mem_*` pattern (`../orchestrator/memory-tools.ts`) exactly: each
 * `execute` calls the internal security routes over `fetch` against
 * `ctx.config.apiBaseUrl`, authenticating with `x-valet-internal` plus the
 * ACTING session id in `x-valet-session-id` (`ctx.sessionId`). Never the
 * service module directly: the HTTP seam is the portability contract.
 *
 * Persona tools name the CHILD's own session id in both the URL and the
 * acting header; the routes resolve the cell claim
 * (`security_cells.child_session_id` = acting session) and find the
 * engagement from it — a child never learns the engagement or runner id.
 *
 * The tools narrate; the routes decide. Every transition error the service
 * throws comes back as a corrective `[security_error]` result, never a
 * throw — a refused transition must not kill the turn.
 *
 * `sec_start` is the one human gate (spec threat 9): the tool fetches the
 * start preview (repo, resolved SHA, plan cells), opens an approval decision
 * gate naming them plus a rough cost estimate, and only calls the start
 * route on approval. This single gate covers every later dispatch.
 */
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolContext, ToolDef, ToolResult } from "@valet/engine";

const UNAVAILABLE_TEXT = "[security_unavailable] security endpoint not configured";

/**
 * Rough per-cell token estimate for the `sec_start` gate body (spec §Tools:
 * "the user approves a number, not a shrug"). Static and imprecise by
 * design; the gate text says so.
 */
export const ESTIMATED_TOKENS_PER_CELL = 500_000;

/** Same idiom as memory-tools' local `defineTool`: preserves the schema's
 * static type so `args` in `execute` is typed precisely. */
function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

interface SecurityToolConfig {
  apiBaseUrl: string;
  internalToken: string;
}

/** `ctx.config` is a verbatim `Record<string, unknown>` passthrough — the
 * security-config shape is only known by convention, hence the narrowing. */
function resolveSecurityConfig(ctx: ToolContext): SecurityToolConfig | null {
  const apiBaseUrl = ctx.config?.apiBaseUrl;
  const internalToken = ctx.config?.internalToken;
  if (typeof apiBaseUrl !== "string" || apiBaseUrl.length === 0) return null;
  if (typeof internalToken !== "string" || internalToken.length === 0) return null;
  return { apiBaseUrl, internalToken };
}

function securityHeaders(cfg: SecurityToolConfig, ctx: ToolContext, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-valet-internal": cfg.internalToken,
    // The ACTING session — the route binds internal-token calls to it.
    "x-valet-session-id": ctx.sessionId,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function parseJsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Non-2xx → `[security_error] …` text, never a throw — a refused
 * transition must not kill the runner's turn. */
async function securityErrorResult(res: Response): Promise<ToolResult> {
  const body = await parseJsonBody(res);
  const message = isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  return { text: `[security_error] ${message}` };
}

/** Shared fetch wrapper for all `sec_*` tools: guarantees a
 * `[security_error]` result instead of a throw for any failure mode —
 * non-2xx responses and network-level rejections alike. */
async function securityRequest(
  url: URL,
  init: RequestInit,
  onOk: (res: Response) => Promise<ToolResult>,
): Promise<ToolResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[security_error] ${message}` };
  }
  if (!res.ok) return securityErrorResult(res);
  return onOk(res);
}

function securityUrl(cfg: SecurityToolConfig, ctx: ToolContext, suffix: string): URL {
  return new URL(`/api/sessions/${encodeURIComponent(ctx.sessionId)}/security${suffix}`, cfg.apiBaseUrl);
}

// ── Response narrowing (validated picks, never blind casts) ───────────────

interface PreviewCell {
  ordinal: number;
  persona: string;
  name: string;
  goal: string;
}

interface StartPreview {
  repoFullName: string;
  resolvedSha: string;
  cells: PreviewCell[];
}

function asStartPreview(body: unknown): StartPreview | null {
  if (!isRecord(body)) return null;
  if (typeof body.repoFullName !== "string" || typeof body.resolvedSha !== "string") return null;
  if (!Array.isArray(body.cells)) return null;
  const cells: PreviewCell[] = [];
  for (const raw of body.cells) {
    if (!isRecord(raw)) return null;
    if (typeof raw.ordinal !== "number" || typeof raw.persona !== "string") return null;
    cells.push({
      ordinal: raw.ordinal,
      persona: raw.persona,
      name: typeof raw.name === "string" ? raw.name : "",
      goal: typeof raw.goal === "string" ? raw.goal : "",
    });
  }
  return { repoFullName: body.repoFullName, resolvedSha: body.resolvedSha, cells };
}

interface CellView {
  id: string;
  ordinal: number;
  persona: string;
  mode: string;
  goal: string;
  dir: string;
  status: string;
  attempts: number;
  childSessionId: string | null;
  progress?: {
    status: string;
    checklist: { pending: number; done: number };
    queue: { pending: number; done: number };
  };
}

function asCellView(raw: unknown): CellView | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  let progress: CellView["progress"];
  if (isRecord(raw.progress) && isRecord(raw.progress.checklist) && isRecord(raw.progress.queue)) {
    progress = {
      status: typeof raw.progress.status === "string" ? raw.progress.status : "",
      checklist: {
        pending: typeof raw.progress.checklist.pending === "number" ? raw.progress.checklist.pending : 0,
        done: typeof raw.progress.checklist.done === "number" ? raw.progress.checklist.done : 0,
      },
      queue: {
        pending: typeof raw.progress.queue.pending === "number" ? raw.progress.queue.pending : 0,
        done: typeof raw.progress.queue.done === "number" ? raw.progress.queue.done : 0,
      },
    };
  }
  return {
    id: raw.id,
    ordinal: typeof raw.ordinal === "number" ? raw.ordinal : 0,
    persona: typeof raw.persona === "string" ? raw.persona : "",
    mode: typeof raw.mode === "string" ? raw.mode : "",
    goal: typeof raw.goal === "string" ? raw.goal : "",
    dir: typeof raw.dir === "string" ? raw.dir : "",
    status: typeof raw.status === "string" ? raw.status : "",
    attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
    childSessionId: typeof raw.childSessionId === "string" ? raw.childSessionId : null,
    ...(progress ? { progress } : {}),
  };
}

function cellLine(cell: CellView): string {
  const child = cell.childSessionId ? ` child=${cell.childSessionId}` : "";
  const progress = cell.progress
    ? ` — ${cell.progress.status}, checklist ${cell.progress.checklist.done} done/${cell.progress.checklist.pending} pending, queue ${cell.progress.queue.done} done/${cell.progress.queue.pending} pending`
    : "";
  return `  ${cell.dir} [${cell.persona}] ${cell.status} (id ${cell.id}, attempts ${cell.attempts})${child}${progress}`;
}

// ── sec_plan_set ───────────────────────────────────────────────────────────

export const secPlanSetTool = defineTool({
  name: "sec_plan_set",
  description:
    "Replace the engagement plan while it is still planning (YAML: ordered cells with persona, mode, goal, " +
    "optional name/reads/paths/review). The plan is immutable once sec_start runs.",
  parameters: Type.Object({
    plan: Type.String({ description: "The full engagement plan YAML." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/plan"),
      { method: "POST", headers: securityHeaders(cfg, ctx, true), body: JSON.stringify({ plan: args.plan }) },
      async (res) => {
        const body = await parseJsonBody(res);
        const cellCount = isRecord(body) && typeof body.cellCount === "number" ? body.cellCount : undefined;
        return { text: `plan set${cellCount !== undefined ? ` (${cellCount} cells)` : ""}` };
      },
    );
  },
});

// ── sec_start ──────────────────────────────────────────────────────────────

export const secStartTool = defineTool({
  name: "sec_start",
  description:
    "Start the engagement: opens an approval gate naming the repo, the resolved commit SHA, the cells, and a " +
    "rough cost estimate. On approval the plan's cells materialize and the repo is pinned to the SHA.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };

    // Everything the gate names comes from the server BEFORE approval, so
    // the user approves facts, not the agent's narration.
    let previewRes: Response;
    try {
      previewRes = await fetch(securityUrl(cfg, ctx, "/start-preview"), {
        method: "GET",
        headers: securityHeaders(cfg, ctx, false),
      });
    } catch (err) {
      return { text: `[security_error] ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!previewRes.ok) return securityErrorResult(previewRes);
    const preview = asStartPreview(await parseJsonBody(previewRes));
    if (!preview) {
      return { text: "[security_error] the start preview returned an unexpected shape. Try sec_status first." };
    }

    const personas = [...new Set(preview.cells.map((cell) => cell.persona))];
    const cellCount = preview.cells.length;
    const estimate = cellCount * ESTIMATED_TOKENS_PER_CELL;
    const body = [
      `Repository: ${preview.repoFullName}`,
      `Pinned commit: ${preview.resolvedSha}`,
      `Cells (${cellCount}):`,
      ...preview.cells.map((cell) => `  ${String(cell.ordinal).padStart(2, "0")} ${cell.name} [${cell.persona}] — ${cell.goal}`),
      `Personas: ${personas.join(", ")}`,
      `Rough estimate: ${cellCount} cells × ~500k tokens ≈ ${estimate.toLocaleString("en-US")} tokens. This is a static estimate, not a quote.`,
      "This one approval covers every cell dispatch in the plan.",
    ].join("\n");

    const resolution = await ctx.requestDecision({
      type: "approval",
      title: `Start the security engagement on ${preview.repoFullName}?`,
      body,
      resumeKey: `sec_start:${preview.resolvedSha}`,
    });
    if (resolution.actionId !== "approve") {
      return { text: "Engagement start was not approved." };
    }

    return securityRequest(
      securityUrl(cfg, ctx, "/start"),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({ resolvedSha: preview.resolvedSha }),
      },
      async (res) => {
        const started = await parseJsonBody(res);
        const cells =
          isRecord(started) && Array.isArray(started.cells)
            ? started.cells.map(asCellView).filter((cell): cell is CellView => cell !== null)
            : [];
        return {
          text: [
            `engagement started on ${preview.repoFullName} at ${preview.resolvedSha} (${cells.length} cells).`,
            ...cells.map(cellLine),
            "Dispatch the first cell with sec_dispatch.",
          ].join("\n"),
        };
      },
    );
  },
});

// ── sec_status ─────────────────────────────────────────────────────────────

export const secStatusTool = defineTool({
  name: "sec_status",
  description:
    "The resume primitive: the engagement, every cell's status, finding counts by severity, and the running " +
    "cell's child settled/liveness. Trust this over your own conversation memory.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/status"),
      { method: "GET", headers: securityHeaders(cfg, ctx, false) },
      async (res) => {
        const body = await parseJsonBody(res);
        if (!isRecord(body) || !isRecord(body.engagement)) {
          return { text: "[security_error] the status route returned an unexpected shape." };
        }
        const engagement = body.engagement;
        const cells = Array.isArray(body.cells)
          ? body.cells.map(asCellView).filter((cell): cell is CellView => cell !== null)
          : [];
        const lines = [
          `engagement ${String(engagement.id)} on ${String(engagement.repoFullName)}` +
            (typeof engagement.repoRef === "string" && engagement.repoRef !== "" ? `@${engagement.repoRef}` : "") +
            ` — ${String(engagement.status)}`,
        ];
        lines.push(cells.length > 0 ? "cells:" : "cells: none (start the engagement with sec_start)");
        lines.push(...cells.map(cellLine));
        if (isRecord(body.findingCounts)) {
          const counts = Object.entries(body.findingCounts)
            .map(([severity, n]) => `${severity} ${typeof n === "number" ? n : 0}`)
            .join(" · ");
          lines.push(`findings: ${counts}`);
        }
        if (isRecord(body.runningChild)) {
          const child = body.runningChild;
          const gone = child.childGone === true;
          lines.push(
            `running cell child ${String(child.childSessionId)}: settled=${child.settled === true}` +
              (typeof child.lastActivityAt === "number" ? ` lastActivityAt=${child.lastActivityAt}` : "") +
              (gone ? " — CHILD GONE: the child session is missing. Call sec_cell_fail, then re-dispatch with mode 'resume'." : ""),
          );
        }
        return { text: lines.join("\n") };
      },
    );
  },
});

// ── sec_dispatch ───────────────────────────────────────────────────────────

export const secDispatchTool = defineTool({
  name: "sec_dispatch",
  description:
    "Dispatch the first pending cell (or a named yielded/failed cell) as a persona child session bound to the " +
    "pinned commit. Serial: refuses while another cell runs. The child's settlement arrives in this thread as a " +
    "child.settled signal.",
  parameters: Type.Object({
    cell_id: Type.Optional(
      Type.String({ description: "Cell to dispatch; omit to dispatch the first pending cell." }),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("fresh"), Type.Literal("resume")], {
        description: "Override the cell's mode. Use 'resume' to continue a yielded cell from its own state doc.",
      }),
    ),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/dispatch"),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({ cellId: args.cell_id, mode: args.mode, threadId: ctx.threadId }),
      },
      async (res) => {
        const body = await parseJsonBody(res);
        const cell = isRecord(body) ? asCellView(body.cell) : null;
        if (!cell) return { text: "dispatched a cell, but the response carried no cell. Call sec_status." };
        return {
          text:
            `dispatched cell ${cell.dir} (id ${cell.id}, attempt ${cell.attempts}, mode ${cell.mode}) ` +
            `to child session ${cell.childSessionId ?? "(unknown)"}. ` +
            "Its settlement will arrive in this thread as a child.settled signal.",
        };
      },
    );
  },
});

// ── sec_cell_complete ──────────────────────────────────────────────────────

export const secCellCompleteTool = defineTool({
  name: "sec_cell_complete",
  description:
    "Rule on a running cell whose child settled. The server checks the exit condition against the cell's latest " +
    "state doc: done → completed; yielding → yielded (re-dispatch with mode 'resume'); otherwise it names the violation.",
  parameters: Type.Object({
    cell_id: Type.String({ description: "The running cell to rule on." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, `/cells/${encodeURIComponent(args.cell_id)}/complete`),
      { method: "POST", headers: securityHeaders(cfg, ctx, true), body: JSON.stringify({}) },
      async (res) => {
        const body = await parseJsonBody(res);
        if (!isRecord(body) || typeof body.outcome !== "string") {
          return { text: "[security_error] the complete route returned an unexpected shape." };
        }
        if (body.outcome === "violation") {
          const violation = typeof body.violation === "string" ? body.violation : "(unnamed violation)";
          return {
            text:
              `outcome: violation — ${violation}\n` +
              "The cell stays running. Use child_send to tell the persona to keep looping, then wait for the next settle.",
          };
        }
        const cell = asCellView(body.cell);
        if (body.outcome === "yielded") {
          return {
            text:
              `outcome: yielded — cell ${cell?.dir ?? args.cell_id} checkpointed with work remaining. ` +
              "Re-dispatch it with sec_dispatch and mode 'resume'.",
          };
        }
        return { text: `outcome: completed — cell ${cell?.dir ?? args.cell_id} is done.` };
      },
    );
  },
});

// ── sec_cell_fail ──────────────────────────────────────────────────────────

export const secCellFailTool = defineTool({
  name: "sec_cell_fail",
  description:
    "Mark a running cell failed, with a reason — for real failures only (child gone, terminal error). " +
    "Re-dispatch the cell afterwards with mode 'resume' to continue from its state doc.",
  parameters: Type.Object({
    cell_id: Type.String(),
    reason: Type.String({ description: "Why the cell failed; carried into the manifest." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, `/cells/${encodeURIComponent(args.cell_id)}/fail`),
      { method: "POST", headers: securityHeaders(cfg, ctx, true), body: JSON.stringify({ reason: args.reason }) },
      async (res) => {
        const body = await parseJsonBody(res);
        const cell = isRecord(body) ? asCellView(body.cell) : null;
        return { text: `cell ${cell?.dir ?? args.cell_id} marked failed: ${args.reason}` };
      },
    );
  },
});

// ── sec_close ──────────────────────────────────────────────────────────────

export const secCloseTool = defineTool({
  name: "sec_close",
  description:
    "Close the engagement once no cell is pending, running, or yielded. Returns the manifest (per-cell stats, " +
    "distinct-fingerprint finding counts by severity, status breakdown) — present it to the user.",
  parameters: Type.Object({}),
  execute: async (_args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/close"),
      { method: "POST", headers: securityHeaders(cfg, ctx, true), body: JSON.stringify({}) },
      async (res) => {
        const body = await parseJsonBody(res);
        const manifest = isRecord(body) ? body.manifest : undefined;
        if (manifest === undefined) {
          return { text: "[security_error] the close route returned no manifest." };
        }
        // The manifest is the engagement's durable summary — the thread
        // keeps it verbatim.
        return { text: JSON.stringify(manifest, null, 2) };
      },
    );
  },
});

// ── sec_handoff ────────────────────────────────────────────────────────────

export const secHandoffTool = defineTool({
  name: "sec_handoff",
  description:
    "Spawn a coding child session to fix one finding: the brief carries the finding's severity, title, location, " +
    "and evidence, and the child gets the engagement repo at the pinned commit.",
  parameters: Type.Object({
    finding_id: Type.String({ description: "The finding to hand off (from sec_findings_list)." }),
    task: Type.Optional(Type.String({ description: "Extra instructions for the fix session." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/handoff"),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({ findingId: args.finding_id, task: args.task, threadId: ctx.threadId }),
      },
      async (res) => {
        const body = await parseJsonBody(res);
        const childSessionId = isRecord(body) && typeof body.childSessionId === "string" ? body.childSessionId : null;
        const title = isRecord(body) && typeof body.title === "string" ? body.title : "";
        if (!childSessionId) return { text: "[security_error] the handoff route returned no child session id." };
        return {
          text: `spawned fix session ${childSessionId}${title ? ` ("${title}")` : ""}. Its settlement will arrive in this thread as a child.settled signal.`,
        };
      },
    );
  },
});

// ── sec_fs_read ────────────────────────────────────────────────────────────

export const secFsReadTool = defineTool({
  name: "sec_fs_read",
  description:
    "Read one engagement-tree path (latest revision by default). /protocol.md and /plan.yml are read-only mounts; " +
    "cells' state docs live at /cells/<dir>/state.yml.",
  parameters: Type.Object({
    path: Type.String({ description: "Tree path, e.g. '/cells/01-recon/state.yml'." }),
    revision: Type.Optional(Type.Integer({ minimum: 1, description: "A specific revision; omit for the latest." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const url = securityUrl(cfg, ctx, "/files");
    url.searchParams.set("path", args.path);
    if (args.revision !== undefined) url.searchParams.set("revision", String(args.revision));
    return securityRequest(url, { method: "GET", headers: securityHeaders(cfg, ctx, false) }, async (res) => {
      const body = await parseJsonBody(res);
      // Verbatim content — the persona/runner reads the tree as a filesystem.
      return { text: isRecord(body) && typeof body.content === "string" ? body.content : "" };
    });
  },
});

// ── sec_fs_list ────────────────────────────────────────────────────────────

export const secFsListTool = defineTool({
  name: "sec_fs_list",
  description: "List engagement-tree paths under a prefix, with each path's latest revision number and size.",
  parameters: Type.Object({
    prefix: Type.Optional(Type.String({ description: "Path prefix, e.g. '/cells/'. Omit for the whole tree." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const url = securityUrl(cfg, ctx, "/files/list");
    if (args.prefix !== undefined) url.searchParams.set("prefix", args.prefix);
    return securityRequest(url, { method: "GET", headers: securityHeaders(cfg, ctx, false) }, async (res) => {
      const body = await parseJsonBody(res);
      const files = isRecord(body) && Array.isArray(body.files) ? body.files : [];
      const lines = files
        .filter(isRecord)
        .map((f) => `${String(f.path)} (rev ${typeof f.revisions === "number" ? f.revisions : "?"}, ${typeof f.size === "number" ? f.size : "?"} bytes)`);
      return { text: lines.length > 0 ? lines.join("\n") : "(empty tree)" };
    });
  },
});

// ── sec_protocol_read (persona) ────────────────────────────────────────────

/**
 * Dedicated protocol read (M5, spec §Context Discipline): pruning protection
 * is per TOOL NAME (`planPrune` keys on `part.toolName`), so protecting
 * `sec_fs_read` wholesale would pin every state-doc read into context
 * forever — the opposite of what pruning exists for. This tool reads ONLY
 * `/protocol.md` and carries `protectedFromPruning`, so the contract the
 * persona operates under survives compaction while ordinary tree reads
 * stay prunable.
 */
export const secProtocolReadTool = defineTool({
  name: "sec_protocol_read",
  description:
    "Read /protocol.md — the contract you operate under. Call it after any compaction, before continuing. " +
    "The result survives context pruning; ordinary sec_fs_read results do not.",
  parameters: Type.Object({}),
  protectedFromPruning: true,
  execute: async (_args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const url = securityUrl(cfg, ctx, "/files");
    url.searchParams.set("path", "/protocol.md");
    return securityRequest(url, { method: "GET", headers: securityHeaders(cfg, ctx, false) }, async (res) => {
      const body = await parseJsonBody(res);
      return { text: isRecord(body) && typeof body.content === "string" ? body.content : "" };
    });
  },
});

// ── sec_findings_list ──────────────────────────────────────────────────────

export const secFindingsListTool = defineTool({
  name: "sec_findings_list",
  description: "List the engagement's findings, filtered and cursor-paginated.",
  parameters: Type.Object({
    cell_id: Type.Optional(Type.String()),
    severity: Type.Optional(
      Type.Union([
        Type.Literal("critical"),
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
        Type.Literal("info"),
      ]),
    ),
    status: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("verified"), Type.Literal("refuted")]),
    ),
    cursor: Type.Optional(Type.String({ description: "The nextCursor value from the previous page." })),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    const url = securityUrl(cfg, ctx, "/findings");
    if (args.cell_id !== undefined) url.searchParams.set("cellId", args.cell_id);
    if (args.severity !== undefined) url.searchParams.set("severity", args.severity);
    if (args.status !== undefined) url.searchParams.set("status", args.status);
    if (args.cursor !== undefined) url.searchParams.set("cursor", args.cursor);
    return securityRequest(url, { method: "GET", headers: securityHeaders(cfg, ctx, false) }, async (res) => {
      const body = await parseJsonBody(res);
      const findings = isRecord(body) && Array.isArray(body.findings) ? body.findings : [];
      const lines = findings.filter(isRecord).map((f) => {
        const location =
          typeof f.file === "string" ? ` ${f.file}${typeof f.line === "number" ? `:${f.line}` : ""}` : "";
        return `[${String(f.severity)}] ${String(f.id)} ${String(f.title)}${location} (${String(f.status)})`;
      });
      const nextCursor = isRecord(body) && typeof body.nextCursor === "string" ? body.nextCursor : null;
      if (lines.length === 0) return { text: "(no findings)" };
      return {
        text: [...lines, ...(nextCursor ? [`more: pass cursor '${nextCursor}'`] : [])].join("\n"),
      };
    });
  },
});

// ── sec_fs_write (persona) ─────────────────────────────────────────────────

export const secFsWriteTool = defineTool({
  name: "sec_fs_write",
  description:
    "Write one file into YOUR cell directory (/cells/<your dir>/...) in the engagement tree. Writes append " +
    "revisions — nothing updates in place. state.yml writes are validated against the protocol. " +
    "Pass `content` inline, OR author the file at a real sandbox path (e.g. /tmp/state.yml) with the Write/Edit " +
    "tools and pass `from_file` — the server reads that path, so you never re-paste or re-escape the whole document.",
  parameters: Type.Object({
    path: Type.String({ description: "Tree path under your cell directory, e.g. '/cells/01-recon/state.yml'." }),
    content: Type.Optional(
      Type.String({ description: "The full file content (the tree stores whole revisions). Provide this OR from_file." }),
    ),
    from_file: Type.Optional(
      Type.String({
        description:
          "A real sandbox path (e.g. '/tmp/state.yml') whose content the server reads for this revision. " +
          "Author it with Write/Edit and commit it here without re-pasting. Provide this OR content.",
      }),
    ),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    // Resolve the content from `from_file` (read the real sandbox path) or the
    // inline `content`. Exactly one — `from_file` is the escape hatch from
    // re-pasting a whole document into the tool call every revision.
    let content: string;
    if (args.from_file !== undefined && args.from_file !== "") {
      if (args.content !== undefined) {
        return { text: "[security_error] Pass content OR from_file, not both. Use from_file to commit a file you authored." };
      }
      try {
        content = await ctx.sandbox.readFile(args.from_file);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          text: `[security_error] Could not read from_file ${args.from_file}: ${detail}. Write the file first with the Write tool, or pass content inline.`,
        };
      }
    } else if (args.content !== undefined) {
      content = args.content;
    } else {
      return { text: "[security_error] Pass content (inline) or from_file (a sandbox path to read)." };
    }
    return securityRequest(
      securityUrl(cfg, ctx, "/files"),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({ path: args.path, content }),
      },
      async (res) => {
        const body = await parseJsonBody(res);
        const revision = isRecord(body) && typeof body.revision === "number" ? body.revision : undefined;
        return { text: `wrote ${args.path}${revision !== undefined ? ` (revision ${revision})` : ""}` };
      },
    );
  },
});

// ── sec_finding_report (persona) ───────────────────────────────────────────

export const secFindingReportTool = defineTool({
  name: "sec_finding_report",
  description:
    "Report one security finding for your cell. The body must carry evidence: a code excerpt and the " +
    "reasoning from source to impact (at least 200 characters). The server computes the fingerprint and " +
    "returns any existing findings that share it — consolidate near-duplicates instead of re-filing.",
  parameters: Type.Object({
    severity: Type.Union([
      Type.Literal("critical"),
      Type.Literal("high"),
      Type.Literal("medium"),
      Type.Literal("low"),
      Type.Literal("info"),
    ]),
    title: Type.String({ description: "One line naming the vulnerability." }),
    file: Type.Optional(Type.String({ description: "Repo path of the affected file." })),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    body: Type.String({
      description: "Evidence: a code excerpt plus the reasoning from source to impact (≥ 200 characters).",
    }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, "/findings"),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({
          severity: args.severity,
          title: args.title,
          file: args.file,
          line: args.line,
          body: args.body,
        }),
      },
      async (res) => {
        const body = await parseJsonBody(res);
        const finding = isRecord(body) && isRecord(body.finding) ? body.finding : null;
        if (!finding) return { text: "[security_error] the finding route returned an unexpected shape." };
        const siblings = isRecord(body) && Array.isArray(body.siblings) ? body.siblings : [];
        const lines = [
          `finding ${String(finding.id)} recorded [${String(finding.severity)}] fingerprint ${String(finding.fingerprint)}`,
        ];
        if (siblings.length > 0) {
          lines.push(
            `${siblings.length} existing finding(s) share this fingerprint: ` +
              siblings
                .filter(isRecord)
                .map((s) => String(s.id))
                .join(", ") +
              ". If yours adds no new evidence, consolidate instead of re-filing.",
          );
        }
        return { text: lines.join("\n") };
      },
    );
  },
});

// ── sec_finding_review (persona, review cells only) ────────────────────────

export const secFindingReviewTool = defineTool({
  name: "sec_finding_review",
  description:
    "Rule on one open finding: 'verified' when the evidence survives your attack, 'refuted' when it does not. " +
    "Forward-only; the reason must name what the evidence shows or what it missed.",
  parameters: Type.Object({
    finding_id: Type.String(),
    status: Type.Union([Type.Literal("verified"), Type.Literal("refuted")]),
    reason: Type.String({ description: "What the evidence shows (verified) or what it missed (refuted)." }),
  }),
  execute: async (args, ctx) => {
    const cfg = resolveSecurityConfig(ctx);
    if (!cfg) return { text: UNAVAILABLE_TEXT };
    return securityRequest(
      securityUrl(cfg, ctx, `/findings/${encodeURIComponent(args.finding_id)}/review`),
      {
        method: "POST",
        headers: securityHeaders(cfg, ctx, true),
        body: JSON.stringify({ status: args.status, reason: args.reason }),
      },
      async (res) => {
        const body = await parseJsonBody(res);
        const finding = isRecord(body) && isRecord(body.finding) ? body.finding : null;
        return {
          text: `finding ${finding ? String(finding.id) : args.finding_id} ${args.status}: ${args.reason}`,
        };
      },
    );
  },
});

/** All eleven runner `sec_*` ToolDefs, in registration order. */
export function buildSecurityRunnerTools(): ToolDef[] {
  return [
    secPlanSetTool,
    secStartTool,
    secStatusTool,
    secDispatchTool,
    secCellCompleteTool,
    secCellFailTool,
    secCloseTool,
    secHandoffTool,
    secFsReadTool,
    secFsListTool,
    secFindingsListTool,
  ];
}

/**
 * The persona `sec_*` ToolDefs for a cell-claimed child session (spec
 * §Tools "Persona tools"). `sec_finding_review` attaches only when the
 * claiming cell has `review: true` — a prompt-injected sweep persona must
 * not refute its peers' findings (spec threat 8).
 */
export function buildSecurityPersonaTools(opts: { review: boolean }): ToolDef[] {
  return [
    secFsWriteTool,
    secFsReadTool,
    secFsListTool,
    secProtocolReadTool,
    secFindingReportTool,
    ...(opts.review ? [secFindingReviewTool] : []),
  ];
}
