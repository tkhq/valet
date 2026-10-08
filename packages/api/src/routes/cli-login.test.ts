/**
 * Browser sign-in for `valet login`: the CLI's loopback flow against a real
 * API with real auth. The "browser" here is the signed-in session cookie
 * driving the same routes the `/cli/login` page calls.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { browserLogin } from "../cli/browser-login.js";
import { AuthError } from "../cli/exit.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function sessionCookie(setCookie: string | null): string {
  const match = setCookie?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error("no session cookie");
  return match[0];
}

async function setup() {
  const testApi = await bootTestApi({ auth: true });
  api = testApi;
  const signUp = await fetch(`${testApi.baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "CLI User", email: "cli@nowhere.test", password: "correct-horse-battery" }),
  });
  expect(signUp.status).toBe(200);
  return { testApi, base: testApi.baseUrl, cookie: sessionCookie(signUp.headers.get("set-cookie")) };
}

/** What the `/cli/login` page does: read the request, then post the person's choice. */
async function approveInBrowser(base: string, cookie: string, approveUrl: string, accept: boolean): Promise<string> {
  const q = new URL(approveUrl).searchParams;
  const info = await fetch(`${base}/api/cli/login?${new URLSearchParams({
    redirect_uri: q.get("redirect_uri") ?? "", code_challenge: q.get("code_challenge") ?? "", device: q.get("device") ?? "",
  }).toString()}`, { headers: { cookie } });
  expect(info.status).toBe(200);
  expect(await info.json()).toMatchObject({ account: "cli@nowhere.test", device: "test-box" });
  const decided = await fetch(`${base}/api/cli/login`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json", Origin: new URL(base).origin },
    body: JSON.stringify({
      redirect_uri: q.get("redirect_uri"), code_challenge: q.get("code_challenge"), state: q.get("state"), device: q.get("device"), accept,
    }),
  });
  expect(decided.status).toBe(200);
  return ((await decided.json()) as { redirect: string }).redirect;
}

describe("valet login browser sign-in", () => {
  it("returns a working personal API key after the person allows it", async () => {
    const { base, cookie } = await setup();
    const lines: string[] = [];
    const key = await browserLogin({
      url: base,
      device: "test-box",
      log: (line) => lines.push(line),
      openUrl: async (url) => {
        expect(new URL(url).pathname).toBe("/cli/login");
        const redirect = await approveInBrowser(base, cookie, url, true);
        // The browser follows the redirect to the CLI's loopback listener.
        const landed = await fetch(redirect);
        expect(await landed.text()).toContain("Valet CLI signed in");
        return true;
      },
    });
    expect(key.startsWith("vlt_")).toBe(true);
    expect(lines.join("\n")).not.toContain(key);
    const me = await fetch(`${base}/api/me`, { headers: { "x-api-key": key } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("cli@nowhere.test");
    const keys = await fetch(`${base}/api/auth/api-key/list`, { headers: { cookie } });
    expect(JSON.stringify(await keys.json())).toContain("valet CLI (test-box)");
  });

  it("rejects with AuthError when the person denies it", async () => {
    const { base, cookie } = await setup();
    await expect(browserLogin({
      url: base,
      device: "test-box",
      log: () => undefined,
      openUrl: async (url) => {
        const redirect = await approveInBrowser(base, cookie, url, false);
        expect(new URL(redirect).searchParams.get("code")).toBeNull();
        await fetch(redirect);
        return true;
      },
    })).rejects.toThrow(/denied/);
  });

  it("gives up with AuthError when nobody approves in time", async () => {
    const { base } = await setup();
    await expect(browserLogin({ url: base, log: () => undefined, openUrl: () => Promise.resolve(false), timeoutMs: 50 }))
      .rejects.toBeInstanceOf(AuthError);
  });

  it("exchanges a code once, and only with its PKCE verifier", async () => {
    const { base, cookie } = await setup();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:45678/callback";
    const approveUrl = `${base}/cli/login?${new URLSearchParams({ redirect_uri: redirectUri, code_challenge: challenge, state: "s", device: "test-box" }).toString()}`;
    const code = new URL(await approveInBrowser(base, cookie, approveUrl, true)).searchParams.get("code") ?? "";
    const exchange = (v: string) => fetch(`${base}/api/cli/login/token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: v, redirect_uri: redirectUri }),
    });
    // A wrong verifier burns the code, so a stolen code cannot be retried.
    expect((await exchange("wrong-verifier")).status).toBe(400);
    expect((await exchange(verifier)).status).toBe(400);
  });

  it("refuses a non-loopback redirect, an API key caller, a foreign origin, and a signed-out visitor", async () => {
    const { base, cookie } = await setup();
    const challenge = createHash("sha256").update("v").digest("base64url");
    const q = (redirect: string) => new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, device: "x" }).toString();

    expect((await fetch(`${base}/api/cli/login?${q("https://evil.example/callback")}`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1/callback")}`, { headers: { cookie } })).status).toBe(400);

    const keyRes = await fetch(`${base}/api/auth/api-key/create`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1:4000/callback")}`, { headers: { "x-api-key": key } })).status).toBe(403);

    const foreign = await fetch(`${base}/api/cli/login`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ redirect_uri: "http://127.0.0.1:4000/callback", code_challenge: challenge, state: "", device: "x", accept: true }),
    });
    expect(foreign.status).toBe(403);

    expect((await fetch(`${base}/api/cli/login?${q("http://127.0.0.1:4000/callback")}`)).status).toBe(401);
  });
});
