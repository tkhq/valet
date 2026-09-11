// packages/api/src/proxy/types.ts  (shared interfaces used by every proxy task)
export type ProviderKind = "anthropic" | "openai";
export interface ProxyUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
}
export interface ParsedUsage {
  usage: ProxyUsage; model: string | null; providerResponseId: string | null;
}
export type ProxyPrincipal = { orgId: string; keyId: string } & (
  | { userId: string; teamId?: never }
  | { userId: null; teamId: string }
);
export interface Upstream { baseUrl: string; apiKey: string; }
