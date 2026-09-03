export { runSessionStoreContract, type StoreContractContext } from "./store-contract.js";
export { runRestartSafeGatesContract } from "./restart-safe-gates-contract.js";
export { runSubmissionLifecycleContract } from "./submission-contract.js";
export { runEventStreamContract, type EventStreamContractContext } from "./event-stream-contract.js";
export { runSandboxContract, type SandboxContractContext } from "./sandbox-contract.js";
export { runConcurrencyContract, type ConcurrencyContractContext } from "./concurrency-contract.js";
// Faux-provider helpers, re-exported from the ENGINE's pi-ai instance.
// Downstream packages (e.g. @valet/eval) must register faux models in the
// same provider registry the engine resolves from; importing
// `@earendil-works/pi-ai/compat` directly from another package can resolve
// a second peer-forked pi-ai copy with its own empty registry (see
// CLAUDE.md, "Node & workspace traps").
export {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
