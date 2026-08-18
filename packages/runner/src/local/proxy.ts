/**
 * Cloud tool proxy for local inference.
 *
 * When valet local needs to call tools like github.*, slack.*, etc.,
 * it proxies through the cloud where credentials are stored.
 */

import { getAuthToken } from "./sync.js";

export interface ToolCall {
  toolId: string;
  params: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

const VALET_API_URL = process.env.VALET_API_URL || "https://valet.turnkey.io";

/**
 * Execute a tool via cloud proxy.
 * The cloud has the credentials; we just send the tool call.
 */
export async function proxyToolCall(call: ToolCall): Promise<ToolResult> {
  const auth = await getAuthToken();
  if (!auth) {
    return {
      success: false,
      error: "Not logged in. Cloud tools require authentication. Run: valet login"
    };
  }

  try {
    const response = await fetch(`${VALET_API_URL}/api/v1/tools/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.sessionToken}`
      },
      body: JSON.stringify({
        tool_id: call.toolId,
        params: call.params
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `Cloud proxy error (${response.status}): ${error}`
      };
    }

    const result = await response.json();
    return result as ToolResult;
  } catch (err) {
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Check if a tool requires cloud proxy.
 * Local tools (filesystem, terminal, mem_*) run locally.
 * Cloud tools (github.*, slack.*, etc.) need proxy.
 */
export function requiresCloudProxy(toolId: string): boolean {
  const localPrefixes = ["filesystem.", "terminal.", "browser.", "mem_"];
  return !localPrefixes.some(prefix => toolId.startsWith(prefix));
}

/**
 * Queue a tool call for later execution (offline mode).
 */
export async function queueToolCall(call: ToolCall): Promise<void> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const { getValetDir } = await import("./sync.js");

  const queueDir = path.join(getValetDir(), "queue");
  await fs.mkdir(queueDir, { recursive: true });

  const queueFile = path.join(queueDir, "pending.json");

  let queue: ToolCall[] = [];
  try {
    const existing = await fs.readFile(queueFile, "utf-8");
    queue = JSON.parse(existing);
  } catch {
    // No existing queue
  }

  queue.push(call);
  await fs.writeFile(queueFile, JSON.stringify(queue, null, 2));
}

/**
 * Flush queued tool calls.
 */
export async function flushQueue(): Promise<ToolResult[]> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const { getValetDir } = await import("./sync.js");

  const queueFile = path.join(getValetDir(), "queue", "pending.json");

  let queue: ToolCall[] = [];
  try {
    const existing = await fs.readFile(queueFile, "utf-8");
    queue = JSON.parse(existing);
  } catch {
    return []; // No queue
  }

  const results: ToolResult[] = [];
  for (const call of queue) {
    const result = await proxyToolCall(call);
    results.push(result);
  }

  // Clear queue
  await fs.unlink(queueFile).catch(() => {});

  return results;
}
