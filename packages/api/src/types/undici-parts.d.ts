// Types for the two undici files that `lib/outbound-url.ts` imports by path.
// The package root registers its Agent as Node's global fetch dispatcher on
// load, so the guard imports only these parts.
declare module "undici/lib/dispatcher/agent.js" {
  import type { Agent } from "undici";
  const AgentClass: typeof Agent;
  export default AgentClass;
}

declare module "undici/lib/api/index.js" {
  import type { Dispatcher } from "undici";
  export const request: Dispatcher["request"];
}
