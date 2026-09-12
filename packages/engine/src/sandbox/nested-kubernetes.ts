export const NESTED_KUBERNETES_IDENTITY = "nested-kubernetes:v1:896546d59c819d3a1bcf837e1bb0aa04fa4a6fecc3b555c51b5b4f5aefcc4079";

/** Pure first-class capability decision. */
export function nestedKubernetesDecision(
  requested: boolean,
  provider: false | "v1" | undefined,
): "ignore" | "allow" | "reject:unsupported_provider" {
  if (!requested) return "ignore";
  return provider === "v1" ? "allow" : "reject:unsupported_provider";
}

export const NESTED_KUBERNETES_UNSUPPORTED =
  "Nested Kubernetes requires the Kubernetes sandbox provider. Change the provider or remove kubernetes: true.";
