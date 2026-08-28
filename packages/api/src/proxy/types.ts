// packages/api/src/proxy/types.ts  (shared interfaces used by every proxy task)
export type ProviderKind = "anthropic" | "openai";
export interface ProxyUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
}
export interface ParsedUsage {
  usage: ProxyUsage; model: string | null; providerResponseId: string | null;
}
export interface ProxyPrincipal { userId: string; orgId: string; keyId: string; }
export interface Upstream { baseUrl: string; apiKey: string; }
