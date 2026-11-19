import { afterEach, describe, expect, it, vi } from "vitest";
import { githubKeyType } from "./github-keys.js";

const KEY = "ssh-ed25519 AAAAC3Nza valet";

function stubLists(lists: { signing: string[]; authentication: string[] }) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    const keys = url.includes("/ssh_signing_keys") ? lists.signing : lists.authentication;
    return new Response(JSON.stringify(keys.map((key, id) => ({ id, key }))), { status: 200 });
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("githubKeyType", () => {
  it("finds a signing key without reading the authentication keys", async () => {
    const urls = stubLists({ signing: ["ssh-ed25519 AAAAC3Nza other-comment"], authentication: [] });
    expect(await githubKeyType("octo", KEY, "https://gh.test")).toBe("signing");
    expect(urls).toEqual(["https://gh.test/users/octo/ssh_signing_keys?per_page=100"]);
  });

  it("finds a key added with GitHub's default Authentication Key type", async () => {
    const urls = stubLists({ signing: [], authentication: ["ssh-ed25519 AAAAC3Nza"] });
    expect(await githubKeyType("octo", KEY, "https://gh.test")).toBe("authentication");
    expect(urls[1]).toBe("https://gh.test/users/octo/keys?per_page=100");
  });

  it("reports a key GitHub does not list", async () => {
    stubLists({ signing: ["ssh-ed25519 BBBB"], authentication: ["ssh-ed25519 CCCC"] });
    expect(await githubKeyType("octo", KEY, "https://gh.test")).toBeNull();
  });
});
