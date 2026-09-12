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
