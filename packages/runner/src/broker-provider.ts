/**
 * Secrets provider that resolves through the Valet API rather than holding a
 * vault credential.
 *
 * This is the point of the broker. The alternative — shipping
 * `OP_SERVICE_ACCOUNT_TOKEN` into every sandbox — gives each sandbox a
 * long-lived key to every vault the service account can read. Here the
 * sandbox holds only its own short-lived session token, and the API decides
 * what that principal may resolve.
 *
 * The value still lands in this process, because something has to put it in a
 * child's environment. What it does NOT do is reach the model: the CLI writes
 * it into `spawn`'s env, and `maskSecrets` scrubs it from anything printed.
 */
import type { SecretsProvider, SecretListEntry } from "./secrets.js";

interface ResolveResponse {
  resolved: Record<string, string>;
  unresolved: string[];
}

export class BrokerProvider implements SecretsProvider {
  readonly name = "valet-broker";
  /** Same surface as the 1Password provider: the broker speaks `op://`. */
  readonly referencePattern = /op:\/\/[^\s"'}\]]+/g;

  private apiUrl = "";
  private token = "";

  async initialize(): Promise<void> {
    const apiUrl = process.env.VALET_API_URL;
    const token = process.env.VALET_SANDBOX_TOKEN;
    if (!apiUrl || !token) {
      throw new Error("VALET_API_URL and VALET_SANDBOX_TOKEN are required to reach the broker");
    }
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
  }

  /**
   * Not served by the broker. Listing every item a token can read is a
   * different capability from resolving one a person named, and the broker
   * deliberately grants only the second.
   */
  async listSecrets(): Promise<SecretListEntry[]> {
    return [];
  }

  async resolveSecret(reference: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/api/sandbox-secrets/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-sandbox": this.token },
      body: JSON.stringify({ references: [reference] }),
    });
    if (!res.ok) {
      // The API's own message names the fixable thing (no token connected, a
      // reference that is not `op://`). Its status is the useful part; the
      // body may carry a vault name, so it is not echoed further than here.
      throw new Error(`broker refused the reference (HTTP ${res.status})`);
    }
    const body = (await res.json()) as ResolveResponse;
    const value = body.resolved[reference];
    if (value === undefined) throw new Error(`no secret found for ${reference}`);
    return value;
  }
}
