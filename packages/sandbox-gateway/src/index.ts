/**
 * Programmatic entry point for `@valet/sandbox-gateway`, consumed by
 * `packages/api` (the reverse-proxy route, Task 6 of the sandbox auth
 * gateway plan) and by this package's own tests. The daemon's process
 * entrypoint (`bin.ts`) is separate and unaffected by this barrel.
 */
export { startGateway, type StartGatewayOpts, type SandboxGatewayTargets, type GatewayHandle } from "./gateway.js";
export { verifyGatewayJwt } from "./jwt.js";
