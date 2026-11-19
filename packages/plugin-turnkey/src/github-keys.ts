/**
 * The GitHub reads commit signing needs. Valet never writes signing keys:
 * the person adds their Valet signing key to GitHub themselves
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`),
 * and Valet checks it on the public `GET /users/{login}/ssh_signing_keys`,
 * which needs no token or permission. The token is used only to read the
 * account's login and noreply address (`GET /user`).
 * `fetch` rather than Octokit: two endpoints do not earn a dependency.
 */

/** What GitHub shows for a pushed commit: the reviewable diff the card links to. */
export interface GitHubCommitView {
  url: string;
  additions: number;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

export interface GitHubAccount {
  login(): Promise<string>;
  /**
   * GitHub's view of a commit, or null when GitHub does not have it (not
   * pushed yet). The commit id fixes the tree, so this diff is exactly what
   * the signature will cover.
   */
  commit(repo: string, sha: string): Promise<GitHubCommitView | null>;
  /**
   * `<id>+<login>@users.noreply.github.com` for the token's account. GitHub
   * marks a signed commit Verified only when its committer email is a
   * verified email of the account that holds the key, and this address
   * always is. The Valet profile email can belong to another account.
   */
  noreplyEmail(): Promise<string>;
}

export const SIGNING_KEY_MISSING_MESSAGE =
  "Your Valet signing key is not on your GitHub account yet, so these commits cannot be signed. Leave the pushed commits unsigned and do not wait. Tell the user once to open Settings, Commit signing, and add the key on GitHub, then run this again after they do.";

export function resolveGithubApiUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
}

const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

export function githubAccount(token: string, apiUrl: string = resolveGithubApiUrl()): GitHubAccount {
  let account: Promise<{ id: number; login: string }> | undefined;
  const read = () =>
    (account ??= (async () => {
      const res = await fetch(`${apiUrl}/user`, { headers: { ...HEADERS, authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`GitHub refused to read your account: ${res.status} ${await safeText(res)}. Reconnect GitHub in Settings.`);
      const body: unknown = await res.json();
      const id = typeof body === "object" && body !== null && "id" in body ? body.id : undefined;
      const login = typeof body === "object" && body !== null && "login" in body ? body.login : undefined;
      if (typeof id !== "number" || typeof login !== "string") throw new Error("GitHub returned no account id and login.");
      return { id, login };
    })());
  return {
    async login() {
      return (await read()).login;
    },
    async commit(repo, sha) {
      const res = await fetch(`${apiUrl}/repos/${repo}/commits/${sha}`, { headers: { ...HEADERS, authorization: `Bearer ${token}` } });
      if (res.status === 404 || res.status === 422) return null;
      if (!res.ok) throw new Error(`GitHub refused to read commit ${sha}: ${res.status} ${await safeText(res)}`);
      return parseCommitView(await res.json());
    },
    async noreplyEmail() {
      const { id, login } = await read();
      return `${id}+${login}@users.noreply.github.com`;
    },
  };
}

/** `ssh-ed25519 AAAA...` without a comment, for comparison. */
function keyBody(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** True when `login` lists `publicKeyLine` as an SSH signing key on GitHub. */
export async function publicSigningKeyListed(
  login: string,
  publicKeyLine: string,
  apiUrl: string = resolveGithubApiUrl(),
): Promise<boolean> {
  const res = await fetch(`${apiUrl}/users/${encodeURIComponent(login)}/ssh_signing_keys?per_page=100`, { headers: HEADERS });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub refused to list signing keys for ${login}: ${res.status} ${await safeText(res)}. Try again.`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return false;
  const want = keyBody(publicKeyLine);
  return body.some((item: unknown) => {
    const key = typeof item === "object" && item !== null && "key" in item ? item.key : undefined;
    return typeof key === "string" && keyBody(key) === want;
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Narrows GitHub's commit JSON to the card's fields. */
export function parseCommitView(body: unknown): GitHubCommitView | null {
  if (typeof body !== "object" || body === null || !("html_url" in body) || typeof body.html_url !== "string") return null;
  const stats = "stats" in body && typeof body.stats === "object" && body.stats !== null ? body.stats : {};
  const files = "files" in body && Array.isArray(body.files) ? body.files : [];
  return {
    url: body.html_url,
    additions: num("additions" in stats ? stats.additions : 0),
    deletions: num("deletions" in stats ? stats.deletions : 0),
    files: files.flatMap((f: unknown) =>
      typeof f === "object" && f !== null && "filename" in f && typeof f.filename === "string"
        ? [{ path: f.filename, additions: num("additions" in f ? f.additions : 0), deletions: num("deletions" in f ? f.deletions : 0) }]
        : [],
    ),
  };
}
