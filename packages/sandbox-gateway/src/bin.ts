/**
 * Node entrypoint for the sandbox gateway daemon.
 *
 *   VALET_SESSION_ID=... VALET_SANDBOX_JWT_SECRET=... node dist/bin.js
 *
 * Reads env, starts the gateway on :9000, and exits loudly if the required
 * env vars are missing — a gateway that silently no-ops on a bad boot would
 * leave the sandbox's terminal/IDE unreachable with no signal why.
 */
import { startGateway } from "./gateway.js";

const TTYD_PORT = 7681;
const VSCODE_PORT = 8765;
const GATEWAY_PORT = 9000;

const sessionId = process.env.VALET_SESSION_ID;
const jwtSecret = process.env.VALET_SANDBOX_JWT_SECRET;
// Not consumed by the gateway itself — logged at boot so it's visible in
// sandbox logs that the daemon knows which API it belongs to (the value
// only matters to other sandbox processes that call back into the API).
const apiUrl = process.env.VALET_API_URL;

if (!sessionId) {
  console.error("FATAL: VALET_SESSION_ID is required to start the sandbox gateway.");
  process.exit(1);
}
if (!jwtSecret) {
  console.error("FATAL: VALET_SANDBOX_JWT_SECRET is required to start the sandbox gateway.");
  process.exit(1);
}

const gateway = startGateway({
  port: GATEWAY_PORT,
  sessionId,
  jwtSecret,
  targets: { ttyd: TTYD_PORT, vscode: VSCODE_PORT },
});

console.log(
  `[sandbox-gateway] listening on :${GATEWAY_PORT} (session=${sessionId}, ttyd=:${TTYD_PORT}, vscode=:${VSCODE_PORT}, VALET_API_URL=${apiUrl ?? "unset"})`,
);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`[sandbox-gateway] received ${signal}, shutting down`);
  await gateway.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
