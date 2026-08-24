/**
 * Tunnel server that exposes local LLM to cloud orchestration.
 * 
 * When running `valet serve --connect cloud`, the CLI:
 * 1. Loads a local model
 * 2. Opens a WebSocket to Valet cloud
 * 3. Receives inference requests from cloud
 * 4. Runs inference locally
 * 5. Streams responses back
 * 
 * This enables PWA users to select "Local Model" and have
 * inference run on their machine while tools execute in cloud.
 */

import { createLocalSession, streamCompletion, cleanupSession, type LocalSession } from "./inference.js";
import { getAuthToken } from "./sync.js";

const VALET_WS_URL = process.env.VALET_WS_URL || "wss://valet.turnkey.io/ws/inference";

export interface TunnelOptions {
  modelPath: string;
  modelName: string;
  pool?: string;  // Optional pool name for org clusters
}

export interface InferenceRequest {
  id: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TunnelStatus {
  connected: boolean;
  modelName: string;
  requestsServed: number;
  uptime: number;
}

/**
 * Start the inference tunnel server.
 * Connects to cloud and serves inference requests.
 */
export async function startTunnel(options: TunnelOptions): Promise<void> {
  const auth = await getAuthToken();
  if (!auth) {
    throw new Error("Not logged in. Run: valet login");
  }

  console.log(`\n🔌 Valet Serve — Tunnel Mode`);
  console.log(`   Model: ${options.modelName}`);
  if (options.pool) {
    console.log(`   Pool: ${options.pool}`);
  }
  console.log("");

  // Load the model
  console.log("Loading model...");
  const session = await createLocalSession(options.modelPath);
  console.log("✓ Model loaded\n");

  // Connect to cloud
  console.log("Connecting to Valet cloud...");
  
  // Dynamic import WebSocket
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsModule: any = await import("ws");
  // In ESM, ws is exported as default; WebSocket is also exported as named export
  const WebSocketClass = wsModule.default || wsModule.WebSocket;
  
  const wsUrl = new URL(VALET_WS_URL);
  wsUrl.searchParams.set("token", auth.sessionToken);
  wsUrl.searchParams.set("model", options.modelName);
  if (options.pool) {
    wsUrl.searchParams.set("pool", options.pool);
  }

  let requestsServed = 0;
  const startTime = Date.now();
  let reconnectAttempts = 0;
  const maxReconnectAttempts = 10;

  function connect() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new WebSocketClass(wsUrl.toString()) as any;

    ws.on("open", () => {
      console.log("✓ Connected to Valet cloud");
      console.log("\nWaiting for inference requests...");
      console.log("Press Ctrl+C to disconnect.\n");
      reconnectAttempts = 0;
    });

    ws.on("message", async (data: Buffer) => {
      try {
        const request = JSON.parse(data.toString()) as InferenceRequest;
        console.log(`← Request ${request.id}: "${request.prompt.slice(0, 50)}..."`);

        // Stream response back
        let tokens = 0;
        for await (const chunk of streamCompletion(session, request.prompt)) {
          ws.send(JSON.stringify({
            type: "chunk",
            id: request.id,
            content: chunk
          }));
          tokens++;
        }

        // Send completion
        ws.send(JSON.stringify({
          type: "done",
          id: request.id,
          tokens
        }));

        requestsServed++;
        console.log(`→ Response ${request.id}: ${tokens} tokens`);
      } catch (err) {
        console.error("Error processing request:", err);
        ws.send(JSON.stringify({
          type: "error",
          id: "unknown",
          error: err instanceof Error ? err.message : String(err)
        }));
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`\nDisconnected (${code}): ${reason || "unknown"}`);
      
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        console.log(`Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
        setTimeout(connect, delay);
      } else {
        console.log("Max reconnect attempts reached. Exiting.");
        process.exit(1);
      }
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n\nShutting down...");
      console.log(`Served ${requestsServed} requests in ${Math.round((Date.now() - startTime) / 1000)}s`);
      ws.close(1000, "Client shutdown");
      process.exit(0);
    });
  }

  connect();

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Get tunnel status (for monitoring).
 */
export function getTunnelStatus(): TunnelStatus {
  // This would be populated by an active tunnel
  return {
    connected: false,
    modelName: "",
    requestsServed: 0,
    uptime: 0
  };
}
