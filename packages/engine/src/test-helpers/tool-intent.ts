import { fauxToolCall as rawFauxToolCall } from "@earendil-works/pi-ai/compat";
import { requiresToolIntent } from "@valet/shared";

/** Valid model fixtures follow the public contract. Intent tests use the raw helper. */
export const fauxToolCall: typeof rawFauxToolCall = (name, args, options) =>
  rawFauxToolCall(name, requiresToolIntent(name) ? { intent: `Exercise ${name} in this test.`, ...args } : args, options);
