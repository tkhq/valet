#!/usr/bin/env bun
/**
 * Runner CLI — entrypoint for the sandbox runner process.
 *
 * Usage:
 *   bun run src/bin.ts \
 *     --opencode-url http://localhost:4096 \
 *     --do-url wss://worker.example.com/ws \
 *     --runner-token <token> \
 *     --session-id <id>
 */

import { parseArgs } from "util";
import { AgentClient } from "./agent-client.js";
import { PromptHandler } from "./prompt.js";
import { startGateway, cleanupAllCloudflared } from "./gateway.js";
import { OpenCodeManager, type OpenCodeConfig } from "./opencode-manager.js";
import {
  createLocalSession,
  streamCompletion,
  cleanupSession,
  resolveModelPath,
  listModels,
  pullModel,
  removeModel,
  MODEL_REGISTRY,
  getModelsDir,
  isLoggedIn,
  getAuthToken,
  saveAuthToken,
  clearAuth,
  sync,
  getSyncDir,
  getCacheDir,
  getValetDir,
  flushQueue,
  startTunnel,
} from "./local/index.js";

// ─── Local Inference Commands ────────────────────────────────────────────

/**
 * Run an interactive local chat session with a specified model.
 */
async function runLocalChat(modelName: string): Promise<void> {
  try {
    const modelPath = await resolveModelPath(modelName);
    const session = await createLocalSession(modelPath);

    console.log(`\n🚀 Valet Local (${modelName})`);
    console.log("Type your message. Ctrl+C to exit.\n");

    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));

    try {
      while (true) {
        const input = await prompt("You: ");
        if (!input.trim()) continue;

        process.stdout.write("Assistant: ");
        try {
          for await (const chunk of streamCompletion(session, input)) {
            process.stdout.write(chunk);
          }
        } catch (err) {
          console.error("\nError during generation:", err);
        }
        console.log("\n");
      }
    } finally {
      rl.close();
      await cleanupSession(session);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${errorMsg}`);
    process.exit(1);
  }
}

/**
 * Handle model management commands.
 */
async function handleModelCommand(subcommand: string, arg?: string): Promise<void> {
  try {
    if (subcommand === "list") {
      const models = await listModels();
      if (models.length === 0) {
        console.log("No models downloaded.\n");
        console.log("Available models:");
        for (const [name, info] of Object.entries(MODEL_REGISTRY)) {
          console.log(`  ${name} (${info.size})`);
        }
        console.log(`\nDownload with: valet model pull <name>`);
      } else {
        console.log("Downloaded models:\n");
        for (const model of models) {
          console.log(`  ${model.name} (${model.size})`);
        }
      }
    } else if (subcommand === "pull") {
      if (!arg) {
        console.error("Model name required: valet model pull <name>");
        process.exit(1);
      }
      await pullModel(arg);
    } else if (subcommand === "rm") {
      if (!arg) {
        console.error("Model name required: valet model rm <name>");
        process.exit(1);
      }
      await removeModel(arg);
    } else {
      console.error(`Unknown model command: ${subcommand}`);
      console.log("Usage: valet model <list|pull|rm> [name]");
      process.exit(1);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${errorMsg}`);
    process.exit(1);
  }
}

function mergeOpenCodeConfig(
  current: OpenCodeConfig,
  partial: Partial<OpenCodeConfig>,
): OpenCodeConfig {
  return {
    tools: partial.tools !== undefined
      ? { ...current.tools, ...partial.tools }
      : { ...current.tools },
    providerKeys: partial.providerKeys !== undefined
      ? { ...current.providerKeys, ...partial.providerKeys }
      : { ...current.providerKeys },
    instructions: partial.instructions !== undefined
      ? partial.instructions
      : [...current.instructions],
    isOrchestrator: partial.isOrchestrator !== undefined
      ? partial.isOrchestrator
      : current.isOrchestrator,
    customProviders: partial.customProviders !== undefined
      ? partial.customProviders
      : current.customProviders,
  };
}

// Parse command-line arguments
const args = Bun.argv.slice(2);

// Check for subcommands first (local, model)
if (args[0] === "local") {
  // valet local [--model <name>]
  const { values: localValues } = parseArgs({
    args: args.slice(1),
    options: {
      model: { type: "string", short: "m" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (localValues.help) {
    console.log(`
Valet Local — Interactive chat with a local LLM

Usage:
  valet local [OPTIONS]

Options:
  -m, --model <name>  Model to use (default: first available or qwen2.5-0.5b)
  -h, --help          Show this help message

Available models:
${Object.entries(MODEL_REGISTRY).map(([name, info]) => `  ${name} (${info.size})`).join("\n")}

Examples:
  valet local
  valet local --model qwen2.5-1.5b
`);
    process.exit(0);
  }

  const modelName = (localValues.model as string) || "qwen2.5-0.5b";
  (async () => {
    try {
      await runLocalChat(modelName);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
} else if (args[0] === "model") {
  // valet model <list|pull|rm> [name]
  const subcommand = args[1];
  const modelArg = args[2];

  if (!subcommand) {
    console.log(`
Valet Model — Manage local LLM models

Usage:
  valet model <command> [name]

Commands:
  list              List downloaded models
  pull <name>       Download a model from HuggingFace
  rm <name>         Delete a downloaded model

Examples:
  valet model list
  valet model pull qwen2.5-1.5b
  valet model rm qwen2.5-0.5b
`);
    process.exit(0);
  }

  (async () => {
    try {
      await handleModelCommand(subcommand, modelArg);
      process.exit(0);
    } catch (err) {
      console.error("Fatal error:", err);
      process.exit(1);
    }
  })();
} else if (args[0] === "login") {
  // valet login - authenticate with Turnkey
  (async () => {
    try {
      console.log("🔐 Opening browser for Turnkey authentication...\n");

      // Start local callback server
      const { createServer } = await import("http");
      const server = createServer();

      const port = await new Promise<number>((resolve) => {
        server.listen(0, () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 9876);
        });
      });

      const callbackUrl = `http://localhost:${port}/callback`;
      const authUrl = `${process.env.VALET_API_URL || 'https://valet.turnkey.io'}/cli/auth?callback=${encodeURIComponent(callbackUrl)}`;

      console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Try to open browser
      const { exec } = await import("child_process");
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${openCmd} "${authUrl}"`);

      // Wait for callback
      const token = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          server.close();
          reject(new Error("Login timed out"));
        }, 120000);

        server.on("request", (req, res) => {
          const url = new URL(req.url || "", `http://localhost:${port}`);
          if (url.pathname === "/callback") {
            const token = url.searchParams.get("token");
            if (token) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<html><body><h1>Login successful!</h1><p>You can close this tab.</p></body></html>");
              clearTimeout(timeout);
              server.close();
              resolve(token);
            } else {
              res.writeHead(400);
              res.end("Missing token");
            }
          }
        });
      });

      // Save token
      await saveAuthToken({
        sessionToken: token,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        userId: "pending" // Will be filled by first API call
      });

      console.log("✓ Logged in successfully!\n");
      console.log("Run 'valet sync' to sync your data.");
      process.exit(0);
    } catch (err) {
      console.error("Login failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();

} else if (args[0] === "logout") {
  // valet logout
  (async () => {
    await clearAuth();
    console.log("✓ Logged out");
    console.log("\nNote: Local data remains in ~/.valet/sync/");
    console.log("Run 'rm -rf ~/.valet' to fully clear local data.");
    process.exit(0);
  })();

} else if (args[0] === "sync") {
  // valet sync [--pull] [--push] [--only memories,skills]
  const { values: syncValues } = parseArgs({
    args: args.slice(1),
    options: {
      pull: { type: "boolean" },
      push: { type: "boolean" },
      only: { type: "string" },
      watch: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (syncValues.help) {
    console.log(`
Valet Sync — Sync data between local and cloud

Usage:
  valet sync [OPTIONS]

Options:
  --pull         Pull from cloud only (don't push local changes)
  --push         Push to cloud only (don't pull)
  --only <list>  Selective sync (comma-separated: memories,skills,workflows,personas,preferences)
  --watch        Continuous bidirectional sync
  -h, --help     Show this help

Examples:
  valet sync                    # Full bidirectional sync
  valet sync --pull             # Pull only
  valet sync --only memories    # Sync only memories
`);
    process.exit(0);
  }

  (async () => {
    try {
      if (!await isLoggedIn()) {
        console.error("Not logged in. Run: valet login");
        process.exit(1);
      }

      await sync({
        pull: syncValues.pull as boolean,
        push: syncValues.push as boolean,
        only: syncValues.only ? (syncValues.only as string).split(",") : undefined
      });

      process.exit(0);
    } catch (err) {
      console.error("Sync failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();

} else if (args[0] === "whoami") {
  // valet whoami - show current user and sync status
  (async () => {
    const auth = await getAuthToken();
    if (!auth) {
      console.log("Not logged in. Run: valet login");
      process.exit(0);
    }

    console.log(`User: ${auth.userId}`);
    console.log(`Session expires: ${new Date(auth.expiresAt).toLocaleString()}`);

    // Check sync status
    const syncDir = getSyncDir();
    try {
      const { promises: fs } = await import("fs");
      const categories = await fs.readdir(syncDir);
      console.log(`\nSynced: ${categories.join(", ") || "nothing"}`);
    } catch {
      console.log("\nNo data synced yet. Run: valet sync");
    }

    process.exit(0);
  })();

} else if (args[0] === "queue") {
  // valet queue <list|flush|clear>
  const subcommand = args[1];

  (async () => {
    const { promises: fs } = await import("fs");
    const path = await import("path");

    const queueFile = path.join(getValetDir(), "queue", "pending.json");

    if (subcommand === "list") {
      try {
        const queue = JSON.parse(await fs.readFile(queueFile, "utf-8"));
        if (queue.length === 0) {
          console.log("No pending tool calls.");
        } else {
          console.log(`${queue.length} pending tool call(s):\n`);
          for (const call of queue) {
            console.log(`  - ${call.toolId}`);
          }
        }
      } catch {
        console.log("No pending tool calls.");
      }
    } else if (subcommand === "flush") {
      console.log("Executing pending tool calls...\n");
      const results = await flushQueue();
      console.log(`Executed ${results.length} call(s).`);
      for (const result of results) {
        console.log(`  ${result.success ? "✓" : "✗"} ${result.error || "success"}`);
      }
    } else if (subcommand === "clear") {
      try {
        await fs.unlink(queueFile);
        console.log("Queue cleared.");
      } catch {
        console.log("Queue already empty.");
      }
    } else {
      console.log(`
Valet Queue — Manage offline tool call queue

Usage:
  valet queue <command>

Commands:
  list    Show pending tool calls
  flush   Execute all pending calls
  clear   Discard pending calls
`);
    }
    process.exit(0);
  })();

} else if (args[0] === "serve") {
  // valet serve --model <name> [--connect cloud] [--pool <name>]
  const { values: serveValues } = parseArgs({
    args: args.slice(1),
    options: {
      model: { type: "string", short: "m" },
      connect: { type: "string" },
      pool: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (serveValues.help) {
    console.log(`
Valet Serve — Expose local model to cloud

Usage:
  valet serve [OPTIONS]

Options:
  -m, --model <name>    Model to serve (required)
  --connect cloud       Connect to Valet cloud as inference endpoint
  --pool <name>         Register in a named pool (for org clusters)
  -h, --help            Show this help

Examples:
  valet serve --model qwen2.5-1.5b --connect cloud
  valet serve --model llama3.2-3b --connect cloud --pool turnkey-internal

This starts a tunnel that:
1. Loads the specified local model
2. Connects to Valet cloud via WebSocket
3. Receives inference requests from PWA/cloud users
4. Runs inference locally and streams responses back

Users in the PWA can select "Local Model" to use your hardware.
`);
    process.exit(0);
  }

  if (!serveValues.model) {
    console.error("Model required: valet serve --model <name>");
    console.log("\nAvailable models:");
    for (const [name, info] of Object.entries(MODEL_REGISTRY)) {
      console.log(`  ${name} (${info.size})`);
    }
    process.exit(1);
  }

  if (serveValues.connect !== "cloud") {
    console.error("Currently only --connect cloud is supported");
    process.exit(1);
  }

  (async () => {
    try {
      if (!(await isLoggedIn())) {
        console.error("Not logged in. Run: valet login");
        process.exit(1);
      }

      const modelPath = await resolveModelPath(serveValues.model as string);
      
      await startTunnel({
        modelPath,
        modelName: serveValues.model as string,
        pool: serveValues.pool as string | undefined
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
} else {
  // Otherwise, parse for runner mode
const { values } = parseArgs({
  args,
  options: {
    "opencode-url": { type: "string" },
    "do-url": { type: "string" },
    "runner-token": { type: "string" },
    "session-id": { type: "string" },
    "gateway-port": { type: "string", default: "9000" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
Valet Runner

Bridges the local OpenCode server and the SessionAgent Durable Object.

Options:
  --opencode-url   URL of the local OpenCode server (e.g. http://localhost:4096)
  --do-url         WebSocket URL of the SessionAgent DO
  --runner-token   Authentication token for the DO WebSocket
  --session-id     Session identifier
  --gateway-port   Auth gateway port (default: 9000)
  -h, --help       Show this help message
`);
  process.exit(0);
}

const opencodeUrl = values["opencode-url"];
const doUrl = values["do-url"];
const runnerToken = values["runner-token"];
const sessionId = values["session-id"];
const gatewayPort = parseInt(values["gateway-port"] || "9000", 10);
const INITIAL_CONNECT_MAX_DELAY_MS = 30_000;
const INITIAL_CONNECT_MAX_ATTEMPTS = 30;

// ─── Tool Whitelist ──────────────────────────────────────────────────────
// When a persona has tool whitelisting configured, this stores the whitelist.
// null/undefined = no whitelist, all tools available (backward compatible).
let activeToolWhitelist: {
  services: string[];
  excludedActions: Array<{ service: string; actionId: string }>;
} | null = null;

/**
 * Check if a tool (identified by service and optional actionId) is allowed
 * by the active tool whitelist.
 */
function isToolAllowed(service: string, actionId?: string): boolean {
  if (!activeToolWhitelist) return true; // No whitelist = all tools allowed
  // Check if the service is in the whitelist
  if (!activeToolWhitelist.services.includes(service)) return false;
  // Check if this specific action is excluded
  if (actionId) {
    const excluded = activeToolWhitelist.excludedActions.some(
      (e) => e.service === service && e.actionId === actionId,
    );
    if (excluded) return false;
  }
  return true;
}

/**
 * Parse a toolId string into service and actionId components.
 * Tool IDs typically follow the pattern "service:actionId" or just "actionId".
 */
function parseToolId(toolId: string): { service: string; actionId?: string } {
  const colonIdx = toolId.indexOf(':');
  if (colonIdx > 0) {
    return { service: toolId.substring(0, colonIdx), actionId: toolId.substring(colonIdx + 1) };
  }
  return { service: toolId };
}

  if (!opencodeUrl || !doUrl || !runnerToken || !sessionId) {
    console.error("Error: --opencode-url, --do-url, --runner-token, and --session-id are required");
    process.exit(1);
  }

  // ─── Build Initial OpenCode Config from Environment ──────────────────────

  function buildInitialConfig(): OpenCodeConfig {
    const providerKeys: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) providerKeys.anthropic = process.env.ANTHROPIC_API_KEY;
    if (process.env.OPENAI_API_KEY) providerKeys.openai = process.env.OPENAI_API_KEY;
    if (process.env.GOOGLE_API_KEY) providerKeys.google = process.env.GOOGLE_API_KEY;

    const tools: Record<string, boolean> = {};
    // Disable Parallel AI tools if the API key is not configured
    if (!process.env.PARALLEL_API_KEY) {
      tools.parallel_web_search = false;
      tools.parallel_web_extract = false;
      tools.parallel_deep_research = false;
      tools.parallel_data_enrichment = false;
    }

    return {
      providerKeys,
      tools,
      instructions: [],
      isOrchestrator: process.env.IS_ORCHESTRATOR === "true",
    };
  }

  // ─── Main ────────────────────────────────────────────────────────────────

  async function main() {
    console.log(`[Runner] Starting for session ${sessionId}`);
    console.log(`[Runner] DO URL: ${doUrl}`);

    // Parse the OpenCode port from the URL
    const opencodePort = new URL(opencodeUrl!).port || "4096";
    const workspaceDir = process.env.WORK_DIR || "/workspace";
    const configSourceDir = "/opencode-config";
    const authJsonPath = "/root/.local/share/opencode/auth.json";

    // ─── Create OpenCode Manager (defer start until DO sends config) ────
    const openCodeManager = new OpenCodeManager({
      workspaceDir,
      port: parseInt(opencodePort, 10),
      configSourceDir,
      authJsonPath,
    });

    // Promise that resolves when the first opencode-config message arrives from the DO
    let resolveFirstConfig: ((config: Partial<OpenCodeConfig>) => void) | null = null;
    const firstConfigPromise = new Promise<Partial<OpenCodeConfig>>((resolve) => {
      resolveFirstConfig = resolve;
    });

    // ─── Connect to SessionAgent DO ─────────────────────────────────────
    const expectRepo = !!process.env.REPO_URL;
    const agentClient = new AgentClient(doUrl!, runnerToken!, { expectRepo });

    // Wire OpenCode crash/fatal callbacks to runner-health messages
    openCodeManager.onCrashed((exitCode, crashCount, healthTimeout) => {
      const kind = healthTimeout ? 'opencode_health_timeout' as const : 'opencode_crash' as const;
      console.log(`[Runner] OpenCode ${healthTimeout ? 'health timeout' : 'crashed'} with exit code ${exitCode} (crash ${crashCount})`);
      agentClient.sendRunnerHealth(kind, { exitCode, crashCount });
    });

    openCodeManager.onFatal(() => {
      console.log('[Runner] OpenCode entered fatal state');
      agentClient.sendRunnerHealth('opencode_fatal', { message: 'OpenCode entered fatal state after too many crashes' });
    });

    // Forward-declared so the `onImage` closure below can read the active messageId
    // from PromptHandler at image send time. Assigned a few lines down.
    // TEMPORARY: Task 12 will plumb messageId through SSE handlers explicitly,
    // making this cross-reference unnecessary.
    let promptHandler: PromptHandler;

    // Start auth gateway with callbacks
    startGateway(gatewayPort, {
      onImage: (data, mimeType, description) => {
        const messageId = promptHandler?.getActiveMessageId();
        if (!messageId) {
          console.warn('[Runner] image dropped — no active prompt messageId');
          return;
        }
        agentClient.sendImage(messageId, data, mimeType, description);
      },
      onSpawnChild: async (params) => {
        const result = await agentClient.requestSpawnChild(params);
        // Notify clients of the new child session for UI updates
        agentClient.sendChildSession(result.childSessionId, params.title || params.workspace);
        return result;
      },
      onTerminateChild: async (childSessionId) => {
        return await agentClient.requestTerminateChild(childSessionId);
      },
      onSelfTerminate: () => {
        agentClient.requestSelfTerminate();
      },
      onSendMessage: async (targetSessionId, content, interrupt) => {
        await agentClient.requestSendMessage(targetSessionId, content, interrupt);
      },
      onReadMessages: async (targetSessionId, limit, after) => {
        const result = await agentClient.requestReadMessages(targetSessionId, limit, after);
        return result.messages;
      },
      onReportGitState: (params) => {
        agentClient.sendGitState(params);
      },
      onMemRead: async (path) => {
        return await agentClient.requestMemRead(path);
      },
      onMemWrite: async (path, content) => {
        return await agentClient.requestMemWrite(path, content);
      },
      onMemPatch: async (path, operations) => {
        return await agentClient.requestMemPatch(path, operations);
      },
      onMemRm: async (path) => {
        return await agentClient.requestMemRm(path);
      },
      onMemSearch: async (query, path, limit) => {
        return await agentClient.requestMemSearch(query, path, limit);
      },
      onListPersonas: async () => {
        return await agentClient.requestListPersonas();
      },
      onListChannels: async () => {
        return await agentClient.requestListChannels();
      },
      onGetSessionStatus: async (targetSessionId) => {
        return await agentClient.requestGetSessionStatus(targetSessionId);
      },
      onListChildSessions: async () => {
        return await agentClient.requestListChildSessions();
      },
      onForwardMessages: async (targetSessionId, limit, after) => {
        return await agentClient.requestForwardMessages(targetSessionId, limit, after);
      },
      onListWorkflows: async () => {
        return await agentClient.requestListWorkflows();
      },
      onSyncWorkflow: async (params) => {
        return await agentClient.requestSyncWorkflow(params);
      },
      onGetWorkflow: async (workflowId) => {
        return await agentClient.requestGetWorkflow(workflowId);
      },
      onUpdateWorkflow: async (workflowId, payload) => {
        return await agentClient.requestUpdateWorkflow(workflowId, payload);
      },
      onDeleteWorkflow: async (workflowId) => {
        return await agentClient.requestDeleteWorkflow(workflowId);
      },
      onRunWorkflow: async (params) => {
        return await agentClient.requestRunWorkflow(
          params.workflowId,
          params.variables,
          {
            repoUrl: params.repoUrl,
            branch: params.branch,
            ref: params.ref,
            sourceRepoFullName: params.sourceRepoFullName,
          },
        );
      },
      onListWorkflowExecutions: async (workflowId, limit) => {
        return await agentClient.requestListWorkflowExecutions(workflowId, limit);
      },
      onListTriggers: async (filters) => {
        return await agentClient.requestListTriggers(filters);
      },
      onSyncTrigger: async (params) => {
        return await agentClient.requestSyncTrigger(params);
      },
      onRunTrigger: async (triggerId, params) => {
        return await agentClient.requestRunTrigger(triggerId, params);
      },
      onDeleteTrigger: async (triggerId) => {
        return await agentClient.requestDeleteTrigger(triggerId);
      },
      onGetExecution: async (executionId) => {
        return await agentClient.requestGetExecution(executionId);
      },
      onGetExecutionSteps: async (executionId) => {
        return await agentClient.requestGetExecutionSteps(executionId);
      },
      onApproveExecution: async (executionId, params) => {
        return await agentClient.requestApproveExecution(executionId, params);
      },
      onCancelExecution: async (executionId, params) => {
        return await agentClient.requestCancelExecution(executionId, params);
      },
      onTunnelsUpdated: (tunnels) => {
        agentClient.sendTunnels(tunnels);
      },
      // Phase C: Mailbox + Task Board
      onMailboxSend: async (params) => {
        return await agentClient.requestMailboxSend(params);
      },
      onMailboxCheck: async (limit, after) => {
        return await agentClient.requestMailboxCheck(limit, after);
      },
      onTaskCreate: async (params) => {
        return await agentClient.requestTaskCreate(params);
      },
      onTaskList: async (params) => {
        return await agentClient.requestTaskList(params);
      },
      onTaskUpdate: async (taskId, updates) => {
        return await agentClient.requestTaskUpdate(taskId, updates);
      },
      onMyTasks: async (status) => {
        return await agentClient.requestMyTasks(status);
      },
      // Phase D: Channel Reply
      onChannelReply: async (channelType, channelId, message, imageBase64, imageMimeType, followUp, fileBase64, fileMimeType, fileName) => {
        return await agentClient.requestChannelReply(channelType, channelId, message, imageBase64, imageMimeType, followUp, fileBase64, fileMimeType, fileName);
      },
      // Tool Discovery & Invocation (with whitelist filtering)
      onListTools: async (service, query) => {
        const result = await agentClient.requestListTools(service, query);
        if (activeToolWhitelist && result.tools) {
          result.tools = (result.tools as Array<{ id?: string; service?: string; actionId?: string; [key: string]: unknown }>).filter((tool) => {
            const svc = tool.service || (tool.id ? parseToolId(tool.id).service : undefined);
            const action = tool.actionId || (tool.id ? parseToolId(tool.id).actionId : undefined);
            if (!svc) return true; // Can't determine service, allow through
            return isToolAllowed(svc, action);
          });
        }
        return result;
      },
      onCallTool: async (toolId, params, summary) => {
        // Enforce whitelist on tool invocation
        if (activeToolWhitelist) {
          const { service, actionId } = parseToolId(toolId);
          if (!isToolAllowed(service, actionId)) {
            throw new Error(`Tool "${toolId}" is not available for this persona`);
          }
        }
        const callResult = await agentClient.requestCallTool(toolId, params, summary);
        // If the action returned images, hand them to the PromptHandler so it
        // can abort the current turn and re-send with vision attachments.
        if (callResult.images?.length) {
          promptHandler?.setPendingVisionImages(callResult.images);
        }
        return { result: callResult.result };
      },
      // Skill API
      onSkillApi: async (action, payload) => {
        return await agentClient.requestSkillApi(action, payload);
      },
      // Persona API
      onPersonaApi: async (action, payload) => {
        return await agentClient.requestPersonaApi(action, payload);
      },
      // Identity API (orchestrator self-edit)
      onIdentityApi: async (action, payload) => {
        return await agentClient.requestIdentityApi(action, payload);
      },
    });
    promptHandler = new PromptHandler(opencodeUrl!, agentClient, sessionId!);

    agentClient.onReconnect(() => {
      if (!promptHandler.isOpenCodeConnected()) {
        console.log('[Runner] Reconnected but OpenCode SSE not active — skipping idle emit');
      } else if (promptHandler.isAnyChannelBusy()) {
        console.log('[Runner] Reconnected while busy — skipping idle emit, SSE will send it when done');
      } else {
        console.log('[Runner] Reconnected while idle — sending agentStatus idle to drain queued work');
        agentClient.sendAgentStatus('idle');
      }
    });

    // Register handlers
    agentClient.onPrompt(async (messageId, content, model, author, modelPreferences, attachments, channelType, channelId, opencodeSessionId, continuationContext, threadId, replyChannelType, replyChannelId) => {
      console.log(`[Runner] Received prompt: ${messageId}${model ? ` (model: ${model})` : ''}${author?.authorName ? ` (by: ${author.authorName})` : ''}${modelPreferences?.length ? ` (prefs: ${modelPreferences.length} models)` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}${channelType ? ` (channel: ${channelType})` : ''}${replyChannelType ? ` (replyChannel: ${replyChannelType})` : ''}${continuationContext ? ' (with continuation context)' : ''}`);
      await promptHandler.handlePrompt(messageId, content, model, author, modelPreferences, attachments, channelType, channelId, opencodeSessionId, continuationContext, threadId, replyChannelType, replyChannelId);
    });

    agentClient.onAnswer(async (questionId, answer) => {
      console.log(`[Runner] Received answer for question: ${questionId}`);
      await promptHandler.handleAnswer(questionId, answer);
    });

    agentClient.onStop(async () => {
      console.log("[Runner] Received stop signal, shutting down");
      await openCodeManager.shutdown();
      agentClient.disconnect();
      process.exit(0);
    });

    agentClient.onAbort(async (channelType, channelId) => {
      console.log(`[Runner] Received abort signal${channelType ? ` (channel: ${channelType}:${channelId})` : ''}`);
      await promptHandler.handleAbort(channelType, channelId);
    });

    agentClient.onInit(async () => {
      console.log("[Runner] Received init from DO");
    });

    agentClient.onRevert(async (messageId) => {
      console.log(`[Runner] Received revert for message: ${messageId}`);
      await promptHandler.handleRevert(messageId);
    });

    agentClient.onDiff(async (requestId) => {
      console.log(`[Runner] Received diff request: ${requestId}`);
      await promptHandler.handleDiff(requestId);
    });

    agentClient.onReview(async (requestId) => {
      console.log(`[Runner] Received review request: ${requestId}`);
      await promptHandler.handleReview(requestId);
    });

    agentClient.onOpenCodeCommand(async (command, args, requestId) => {
      console.log(`[Runner] Received OpenCode command: /${command} (requestId=${requestId})`);
      await promptHandler.executeOpenCodeCommand(command, args, requestId);
    });

    agentClient.onNewSession(async (channelType, channelId, requestId) => {
      console.log(`[Runner] New session requested for ${channelType}:${channelId}`);
      await promptHandler.handleNewSession(channelType, channelId, requestId);
    });

    agentClient.onWorkflowExecute(async (executionId, payload, model, modelPreferences) => {
      console.log(`[Runner] Received workflow execution dispatch: ${executionId} (${payload.kind})`);
      await promptHandler.handleWorkflowExecutionDispatch(executionId, payload, model, modelPreferences);
    });

    agentClient.onTunnelDelete(async (name, actor) => {
      console.log(`[Runner] Received tunnel delete: ${name} (actor=${actor?.name || actor?.email || actor?.id || "unknown"})`);
      try {
        const resp = await fetch(`http://localhost:${gatewayPort}/api/tunnels/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`[Runner] Tunnel delete failed: ${errText}`);
        }
      } catch (err) {
        console.error("[Runner] Tunnel delete error:", err);
      }
    });

    // ─── OpenCode Config Handler ──────────────────────────────────────────
    agentClient.onOpenCodeConfig(async (config) => {
      console.log("[Runner] Received opencode-config from DO");

      // First config: resolve the promise so main() handles the initial start
      if (resolveFirstConfig) {
        console.log("[Runner] First opencode-config received, deferring to boot sequence");
        resolveFirstConfig(config);
        resolveFirstConfig = null;
        return;
      }

      // Subsequent configs: hot-reload via setDesiredConfig (for admin config pushes)
      try {
        promptHandler.setProviderModelConfigs(config.customProviders, config.builtInProviderModelConfigs);
        const merged = mergeOpenCodeConfig(currentConfig, config);
        // Check if config actually changed before canceling in-flight work
        const result = await openCodeManager.setDesiredConfig(merged);
        if (result.restarted) {
          await promptHandler.handleOpenCodeRestart();
          currentConfig = merged;
          await promptHandler.handleOpenCodeRestarted();
        }
        agentClient.sendOpenCodeConfigApplied(true, result.restarted);
        agentClient.sendAgentStatus("idle");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[Runner] Failed to apply opencode config:", errorMsg);
        agentClient.sendOpenCodeConfigApplied(false, false, errorMsg);
      }
    });

    // ─── Plugin Content Handler ────────────────────────────────────────────
    agentClient.onPluginContent(async (content) => {
      console.log(`[Runner] Received plugin-content: ${content.personas.length} persona(s), ${content.skills.length} skill(s), ${content.tools.length} tool(s), toolWhitelist=${content.toolWhitelist ? `${content.toolWhitelist.services.length} service(s)` : 'none'}`);

      // Store tool whitelist for filtering list-tools and call-tool
      activeToolWhitelist = content.toolWhitelist ?? null;

      const { mkdirSync } = await import('node:fs');
      const baseDir = '/root/.opencode';

      // Write persona files to .valet/persona/ — OpenCode watches this glob
      // via opencode.json instructions, so changes are picked up automatically.
      if (content.personas.length > 0) {
        const personaDir = '/workspace/.valet/persona';
        mkdirSync(personaDir, { recursive: true });
        for (const persona of content.personas) {
          await Bun.write(`${personaDir}/${persona.filename}`, persona.content);
        }
      }

      // Write skill files
      if (content.skills.length > 0) {
        const dir = `${baseDir}/skills`;
        mkdirSync(dir, { recursive: true });
        for (const skill of content.skills) {
          await Bun.write(`${dir}/${skill.filename}`, skill.content);
        }
      }

      // Write tool/plugin files
      if (content.tools.length > 0) {
        const dir = `${baseDir}/plugins/valet`;
        mkdirSync(dir, { recursive: true });
        for (const tool of content.tools) {
          await Bun.write(`${dir}/${tool.filename}`, tool.content);
        }
      }

      console.log('[Runner] Plugin content written to filesystem');
    });

    // ─── Graceful Shutdown ────────────────────────────────────────────────
    const shutdown = async () => {
      console.log("[Runner] Shutting down...");
      cleanupAllCloudflared();
      await openCodeManager.shutdown();
      agentClient.disconnect();
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    // Initial connect must be resilient too. If the first websocket upgrade fails
    // (cold start/race/network blip), keep retrying instead of exiting the runner.
    // Cap attempts so stale sandboxes (rotated session, broken network) don't retry forever.
    let initialConnectAttempt = 0;
    while (true) {
      initialConnectAttempt++;
      try {
        await agentClient.connect();
        break;
      } catch (err) {
        if (initialConnectAttempt >= INITIAL_CONNECT_MAX_ATTEMPTS) {
          console.error(
            `[Runner] Initial DO connection failed after ${initialConnectAttempt} attempts — giving up`,
          );
          process.exit(1);
        }
        const delayMs = Math.min(1000 * 2 ** (initialConnectAttempt - 1), INITIAL_CONNECT_MAX_DELAY_MS);
        console.error(
          `[Runner] Initial DO connection failed (attempt ${initialConnectAttempt}/${INITIAL_CONNECT_MAX_ATTEMPTS}). Retrying in ${delayMs}ms:`,
          err,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // ─── Wait for DO config, then start OpenCode (single start) ─────────
    console.log("[Runner] Waiting for opencode-config from DO...");

    const CONFIG_WAIT_TIMEOUT_MS = 30_000;
    const doConfig = await Promise.race([
      firstConfigPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CONFIG_WAIT_TIMEOUT_MS)),
    ]);

    let currentConfig = buildInitialConfig();

    if (doConfig) {
      console.log("[Runner] Got opencode-config from DO, merging with env config");
      // Merge DO config on top of env-based config
      currentConfig = mergeOpenCodeConfig(currentConfig, doConfig);
      // Set provider/model filtering from DO config before model discovery
      promptHandler.setProviderModelConfigs(
        (doConfig as any).customProviders,
        (doConfig as any).builtInProviderModelConfigs,
      );
    } else {
      console.warn("[Runner] Timed out waiting for opencode-config from DO, starting with env-only config");
      // Consume the first-config resolver so late arrivals go through the hot-reload path
      resolveFirstConfig = null;
    }

    console.log(`[Runner] Starting OpenCode with ${Object.keys(currentConfig.providerKeys).length} provider key(s)`);
    await openCodeManager.setDesiredConfig(currentConfig);
    console.log(`[Runner] OpenCode URL: ${openCodeManager.getUrl()}`);

    // Ack config to the DO
    agentClient.sendOpenCodeConfigApplied(true, false);

    // Wait for repo clone AND plugin content to finish before signaling idle.
    // The DO drains queued prompts on idle, and the agent needs both the working
    // tree checked out and persona/skill/tool files written before it can act.
    const BOOT_WAIT_TIMEOUT_MS = 120_000; // 2 min — large repos can take a while
    let bootTimeoutHandle: ReturnType<typeof setTimeout>;
    const bootResult = await Promise.race([
      Promise.all([agentClient.repoReady, agentClient.pluginContentReady]).then(() => "ready" as const),
      new Promise<"timeout">((resolve) => {
        bootTimeoutHandle = setTimeout(() => resolve("timeout"), BOOT_WAIT_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(bootTimeoutHandle!);
    if (bootResult === "timeout") {
      console.warn("[Runner] Timed out waiting for boot prerequisites (repo clone / plugin content) — proceeding");
    } else {
      console.log("[Runner] Boot prerequisites complete (repo clone + plugin content)");
    }

    // Signal readiness — this triggers the DO to drain any queued prompts.
    agentClient.sendAgentStatus("idle");
    console.log("[Runner] Ready — sent initial agentStatus: idle to DO");

    // Discover models in background — not needed for prompt handling
    promptHandler.fetchAvailableModels().then((models) => {
      if (models.length > 0) {
        agentClient.sendModels(models);
        console.log(`[Runner] Sent ${models.length} provider(s) to DO`);
      }
    }).catch((err) => {
      console.warn("[Runner] Background model discovery failed:", err);
    });
  }

  main().catch((err) => {
    console.error("[Runner] Fatal error:", err);
    process.exit(1);
  });
}