/**
 * The two GitHub calls commit signing needs: add an SSH signing key to the
 * user's account for the window, and remove it after. Both are user-to-server
 * calls under the GitHub App user permission "SSH signing keys" (write).
 * `fetch` rather than Octokit: two endpoints do not earn a dependency.
 */

export interface GitHubSigningKeys {
  create(title: string, key: string): Promise<{ id: number }>;
  remove(id: number): Promise<void>;
}

export const GITHUB_PERMISSION_MESSAGE =
  "GitHub refused to add the signing key. An admin must grant the GitHub App the " +
  '"SSH signing keys" write permission, then you must reconnect GitHub under Settings, Connected accounts.';

export function resolveGithubApiUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
}

export function githubSigningKeys(token: string, apiUrl: string = resolveGithubApiUrl()): GitHubSigningKeys {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  return {
    async create(title, key) {
      const res = await fetch(`${apiUrl}/user/ssh_signing_keys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, key }),
      });
      if (res.status === 403 || res.status === 404) throw new Error(GITHUB_PERMISSION_MESSAGE);
      if (!res.ok) throw new Error(`GitHub refused to add the signing key: ${res.status} ${await safeText(res)}`);
      const body: unknown = await res.json();
      const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
      if (typeof id !== "number") throw new Error("GitHub added the signing key but returned no id.");
      return { id };
    },
    async remove(id) {
      const res = await fetch(`${apiUrl}/user/ssh_signing_keys/${id}`, { method: "DELETE", headers });
      // 404: already gone, which is the state we want.
      if (res.status === 204 || res.status === 404) return;
      if (res.status === 403) throw new Error(GITHUB_PERMISSION_MESSAGE);
      throw new Error(`GitHub refused to remove signing key ${id}: ${res.status} ${await safeText(res)}`);
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
