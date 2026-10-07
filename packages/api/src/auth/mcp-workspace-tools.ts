/**
 * MCP tools for the rest of a workspace: skills, memory, workflows, the
 * approvals inbox, and artifacts
 * (`docs/specs/2026-10-07-mcp-agent-tools-design.md`, "Workspace tools").
 *
 * Same rule as `mcp-tools.ts`: every tool calls an existing `/api` route
 * in-process as the verified user, so each area's ownership and permission
 * rules apply unchanged. The tools only reshape requests and responses.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { renderTemplate } from "@valet/engine";
import { z } from "zod";
import type {
  GetSkillResponse,
  GetWorkflowRunResponse,
  ListArtifactsResponse,
  ListNotificationDecisionsResponse,
  ListSkillsResponse,
  ListWorkflowActionRequiredResponse,
  ListWorkflowsResponse,
  ShareArtifactResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";
import type { McpToolDeps } from "./mcp-tools.js";

const MAX_TEXT_CHARS = 20_000;
const DEFAULT_RUN_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const POLL_MS = 1_000;

class ApiError extends Error {}

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> };
}

function run<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof ApiError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
  };
}

async function call<T>(deps: McpToolDeps, method: "GET" | "POST" | "PUT", path: string, what: string, body?: unknown): Promise<T> {
  const res = await deps.api(method, path, body);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const detail = res.body && typeof res.body === "object" && "error" in res.body && typeof res.body.error === "string" ? res.body.error : undefined;
  if (res.status === 404 && !detail) throw new ApiError(`${what} not found, or you do not have access to it.`);
  throw new ApiError(detail ? `${what}: ${detail}` : `${what} request failed with status ${res.status}.`);
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated ${text.length - MAX_TEXT_CHARS} characters]` : text;
}

/** Owner query parameters for routes that take `ownerType`/`ownerId`. A personal workspace sends none. */
function ownerParams(workspace: string | undefined, params = new URLSearchParams()): URLSearchParams {
  if (workspace && workspace !== "user") {
    params.set("ownerType", "team");
    params.set("ownerId", workspace);
  }
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  return params.size > 0 ? `${path}?${params.toString()}` : path;
}

const workspaceArg = z.string().min(1).optional()
  .describe('Workspace: "user" for your personal workspace, or a team id from list_workspaces. Default: "user".');

type RunView = {
  run_id: string;
  workflow_id: string;
  status: string;
  outcome?: string;
  pending_approvals?: Array<{ node_id: string; kind: string; summary?: string; action?: string; risk_level?: string }>;
  url: string;
};

function runView(deps: McpToolDeps, detail: GetWorkflowRunResponse): RunView {
  const { run: r } = detail;
  return {
    run_id: r.runId,
    workflow_id: r.workflowId,
    status: r.status,
    ...(r.outcome ? { outcome: r.outcome } : {}),
    ...(detail.pendingGates.length > 0
      ? { pending_approvals: detail.pendingGates.map((g) => ({
          node_id: g.nodeId, kind: g.kind,
          ...(g.summary ?? g.prompt ? { summary: g.summary ?? g.prompt } : {}),
          ...(g.service && g.action ? { action: `${g.service}.${g.action}` } : {}),
          ...(g.riskLevel ? { risk_level: g.riskLevel } : {}),
        })) }
      : {}),
    url: `${deps.origin}/workflows/runs/${encodeURIComponent(r.runId)}`,
  };
}

/** Wait for a run to settle or stop on an approval. A timeout returns the current state. */
async function waitForRun(deps: McpToolDeps, runId: string, waitSeconds: number): Promise<RunView> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitSeconds * 1000;
  for (;;) {
    const detail = await call<GetWorkflowRunResponse>(deps, "GET", `/api/workflows/runs/${encodeURIComponent(runId)}`, "Workflow run");
    const view = runView(deps, detail);
    if (detail.run.status === "settled" || detail.pendingGates.length > 0 || now() >= deadline) return view;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
}

export function registerWorkspaceTools(server: McpServer, deps: McpToolDeps): void {
  // ── Skills ────────────────────────────────────────────────────────────

  server.registerTool(
    "list_skills",
    {
      description:
        "Lists the skills (playbooks) your Valet organization and teams maintain. " +
        "Call get_skill with a name to read one before you follow it.",
      inputSchema: {
        query: z.string().min(1).optional().describe("Only skills whose name or description matches this text."),
        workspace: workspaceArg,
        limit: z.number().int().min(1).max(100).optional().describe("Maximum skills to return. Default: 50."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ query, workspace, limit }: { query?: string; workspace?: string; limit?: number }) => {
      const params = ownerParams(workspace);
      if (query) params.set("q", query);
      params.set("limit", String(limit ?? 50));
      const res = await call<ListSkillsResponse>(deps, "GET", withQuery("/api/skills", params), "Skills");
      return {
        skills: res.skills.map((s) => ({
          name: s.name,
          description: s.description,
          ...("takesArgs" in s && s.takesArgs ? { takes_args: true } : {}),
        })),
        ...(res.nextCursor ? { more: "More skills exist. Narrow the query." } : {}),
      };
    }),
  );

  server.registerTool(
    "get_skill",
    {
      description:
        "Returns one skill's full instructions. Follow them with your own tools. " +
        "Where a skill names a Valet tool such as call_tool, use the Valet MCP tool of that name. " +
        "Pass args to fill a skill's {{placeholders}}.",
      inputSchema: {
        name: z.string().min(1).describe("Skill name from list_skills."),
        args: z.record(z.string(), z.unknown()).optional().describe("Values for the skill's {{placeholders}}."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ name, args }: { name: string; args?: Record<string, unknown> }) => {
      const skill = await call<GetSkillResponse>(deps, "GET", `/api/skills/${encodeURIComponent(name)}`, "Skill");
      return {
        name: skill.name,
        description: skill.description,
        instructions: clip(args ? renderTemplate(skill.content, args) : skill.content),
      };
    }),
  );

  // ── Memory ────────────────────────────────────────────────────────────

  server.registerTool(
    "search_memory",
    {
      description: "Searches Valet memory: the notes, decisions, and context your Valet agents and your team saved.",
      inputSchema: {
        query: z.string().min(1).describe("Search text."),
        workspace: workspaceArg,
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results. Default: 10."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ query, workspace, limit }: { query: string; workspace?: string; limit?: number }) => {
      const params = ownerParams(workspace, new URLSearchParams({ q: query, limit: String(limit ?? 10) }));
      return call<unknown>(deps, "GET", withQuery("/api/memory/search", params), "Memory search");
    }),
  );

  server.registerTool(
    "read_memory",
    {
      description: "Reads one memory file, or a directory's index when the path is a directory. Use an empty path for the root index.",
      inputSchema: {
        path: z.string().describe('Memory path from search_memory or an index, e.g. "projects/valet.md". Use "" for the root.'),
        workspace: workspaceArg,
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ path, workspace }: { path: string; workspace?: string }) => {
      const params = ownerParams(workspace, new URLSearchParams({ path }));
      const res = await call<unknown>(deps, "GET", withQuery("/api/memory", params), "Memory file");
      if (res && typeof res === "object" && "content" in res && typeof res.content === "string") return { ...res, content: clip(res.content) };
      return res;
    }),
  );

  server.registerTool(
    "write_memory",
    {
      description:
        "Creates or replaces a memory file so your Valet agents and your team can use it later. " +
        "Write durable knowledge: decisions, conventions, and context. Writing to a team workspace needs team admin rights.",
      inputSchema: {
        path: z.string().min(1).describe('Memory path, e.g. "projects/valet/decisions.md".'),
        content: z.string().min(1).describe("Markdown content. Replaces the file."),
        description: z.string().optional().describe("One-line summary for search results and indexes."),
        tags: z.array(z.string()).optional().describe("Tags for search."),
        workspace: workspaceArg,
      },
      annotations: { destructiveHint: true },
    },
    run(async ({ path, content, description, tags, workspace }: { path: string; content: string; description?: string; tags?: string[]; workspace?: string }) =>
      call<unknown>(deps, "PUT", withQuery("/api/memory", ownerParams(workspace)), "Memory write", {
        path, content,
        ...(description ? { description } : {}),
        ...(tags ? { tags } : {}),
      })),
  );

  // ── Workflows ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_workflows",
    {
      description: "Lists the Valet workflows (saved automations) you can run, with each one's latest run.",
      inputSchema: { workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    run(async ({ workspace }: { workspace?: string }) => {
      const res = await call<ListWorkflowsResponse>(deps, "GET", withQuery("/api/workflows", ownerParams(workspace)), "Workflows");
      return {
        workflows: res.workflows.map((w) => ({
          workflow_id: w.id,
          name: w.name,
          owner: `${w.ownerType}:${w.ownerId}`,
          ...(w.latestRun ? { latest_run: { run_id: w.latestRun.runId, status: w.latestRun.status, ...(w.latestRun.outcome ? { outcome: w.latestRun.outcome } : {}) } } : {}),
        })),
      };
    }),
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "Starts a workflow run and, by default, waits for it to finish. If it stops for approval, a person approves it in Valet; " +
        "check again later with get_workflow_run.",
      inputSchema: {
        workflow_id: z.string().min(1).describe("Workflow id from list_workflows."),
        input: z.record(z.string(), z.unknown()).optional().describe("Run input, when the workflow declares inputs."),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe(`Seconds to wait (0-${MAX_WAIT_SECONDS}). Default: ${DEFAULT_RUN_WAIT_SECONDS}.`),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    run(async ({ workflow_id, input, wait_seconds }: { workflow_id: string; input?: Record<string, unknown>; wait_seconds?: number }) => {
      const started = await call<StartWorkflowRunResponse>(deps, "POST", `/api/workflows/${encodeURIComponent(workflow_id)}/runs`, "Workflow", input ? { input } : {});
      return waitForRun(deps, started.runId, wait_seconds ?? DEFAULT_RUN_WAIT_SECONDS);
    }),
  );

  server.registerTool(
    "get_workflow_run",
    {
      description: "Reads a workflow run's status, outcome, and pending approvals. With wait_seconds, it waits for the run to finish first.",
      inputSchema: {
        run_id: z.string().min(1).describe("Run id from run_workflow or list_workflows."),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().describe("Seconds to wait for the run to finish. Default: 0."),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ run_id, wait_seconds }: { run_id: string; wait_seconds?: number }) => waitForRun(deps, run_id, wait_seconds ?? 0)),
  );

  // ── Approvals inbox ───────────────────────────────────────────────────

  server.registerTool(
    "list_inbox",
    {
      description:
        "Lists everything waiting for you in Valet: questions and approvals in threads, and workflow runs waiting for approval. " +
        "You can answer a question with resolve_decision. Approvals need a person: give them the url.",
      annotations: { readOnlyHint: true },
    },
    run(async () => {
      const decisions = await call<ListNotificationDecisionsResponse>(deps, "GET", "/api/notifications/decisions", "Inbox");
      const workflows = await call<ListWorkflowActionRequiredResponse>(deps, "GET", "/api/workflows/action-required", "Inbox");
      return {
        thread_decisions: decisions.items.map(({ gate, title }) => ({
          thread_id: gate.threadId,
          gate_id: gate.id,
          type: gate.type,
          title: gate.title,
          conversation: title,
          options: gate.actions.map((a) => ({ action_id: a.id, label: a.label })),
          agent_can_answer: gate.type === "question",
          url: `${deps.origin}/threads/${encodeURIComponent(gate.threadId)}`,
        })),
        workflow_approvals: workflows.items.map((item) => ({
          run_id: item.runId,
          workflow: item.workflowName,
          node_id: item.gate.nodeId,
          kind: item.gate.kind,
          ...(item.gate.summary ?? item.gate.prompt ? { summary: item.gate.summary ?? item.gate.prompt } : {}),
          ...(item.gate.service && item.gate.action ? { action: `${item.gate.service}.${item.gate.action}` } : {}),
          url: `${deps.origin}/workflows/runs/${encodeURIComponent(item.runId)}`,
        })),
        ...(decisions.nextCursor ? { more: "More thread decisions exist. Open the Valet inbox to see all of them." } : {}),
      };
    }),
  );

  // ── Artifacts ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_artifacts",
    {
      description: "Lists published Valet artifacts (shareable pages and documents) in a workspace.",
      inputSchema: { workspace: workspaceArg },
      annotations: { readOnlyHint: true },
    },
    run(async ({ workspace }: { workspace?: string }) => {
      const res = await call<ListArtifactsResponse>(deps, "GET", withQuery("/api/artifacts", ownerParams(workspace)), "Artifacts");
      return {
        artifacts: res.artifacts.filter((a) => !a.revoked).map((a) => ({
          key: a.path, title: a.title, format: a.format, version: a.version, visibility: a.visibility, url: a.url,
          updated_at: new Date(a.updatedAt).toISOString(),
        })),
      };
    }),
  );

  server.registerTool(
    "publish_artifact",
    {
      description:
        "Publishes markdown or HTML as a Valet artifact page and returns its link. " +
        "Publishing again with the same key adds a new version at the same link.",
      inputSchema: {
        key: z.string().min(1).max(200).describe('Stable key for this artifact, e.g. "reports/test-summary". Reuse it to update the page.'),
        content: z.string().min(1).describe("The page content."),
        title: z.string().min(1).max(200).optional().describe("Page title. Without one, the content's first heading becomes the title."),
        format: z.enum(["markdown", "html"]).optional().describe("Default: markdown."),
        description: z.string().max(500).optional().describe("One-line summary."),
        workspace: workspaceArg,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    run(async ({ key, content, title, format, description, workspace }: { key: string; content: string; title?: string; format?: "markdown" | "html"; description?: string; workspace?: string }) => {
      const res = await call<ShareArtifactResponse>(deps, "POST", withQuery("/api/artifacts/share", ownerParams(workspace)), "Artifact", {
        key, content, format: format ?? "markdown",
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
      });
      return { key: res.path, url: res.url, version: res.version, visibility: res.visibility };
    }),
  );
}
