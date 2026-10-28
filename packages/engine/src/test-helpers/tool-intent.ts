import { fauxToolCall as rawFauxToolCall } from "@earendil-works/pi-ai/compat";
import { builtinTools } from "../builtin-tools/index.js";

/** Valid model fixtures follow the public contract. Intent tests use the raw helper. */
export const fauxToolCall: typeof rawFauxToolCall = (name, args, options) => {
  const primitive = builtinTools.find(tool => tool.name === name)?.intent === "exempt";
  const field = name === "call_tool" || name.includes("__") ? "summary" : "intent";
  return rawFauxToolCall(name, primitive ? args : { [field]: `Exercise ${name} in this test.`, ...args }, options);
};
