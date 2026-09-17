/**
 * `/api/credentials/google_workspace/folder-scope` — the folders a person
 * lets Valet see in Drive. Enforcement lives in the google-workspace
 * plugin; this covers the read/write surface the settings UI drives.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

const HEADERS = { "Content-Type": "application/json" };
const SERVICE = "google_workspace";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllGlobals();
});

async function connectDrive(baseUrl: string): Promise<void> {
  const put = await fetch(`${baseUrl}/api/credentials/${SERVICE}`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ type: "oauth2", accessToken: "ya29.drive-token" }),
  });
  expect(put.status).toBe(200);
}

function scopeUrl(baseUrl: string, service = SERVICE): string {
  return `${baseUrl}/api/credentials/${service}/folder-scope`;
}

describe("GET/PUT/DELETE /api/credentials/:service/folder-scope", () => {
  it("reports no scope until one is set", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const res = await fetch(scopeUrl(api.baseUrl));
    expect(res.status).toBe(200);
    // null is unrestricted. It is not the same as [], which denies everything.
    expect(await res.json()).toEqual({ folderIds: null });
  });

  it("stores the folders and reads them back", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const put = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: ["fold-A", "fold-B"] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ folderIds: ["fold-A", "fold-B"] });

    const get = await fetch(scopeUrl(api.baseUrl));
    expect(await get.json()).toEqual({ folderIds: ["fold-A", "fold-B"] });
  });

  it("keeps the access token intact when the scope changes", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: ["fold-A"] }),
    });

    // The scope write updates one metadata key. A read-modify-save through
    // the credential store would round-trip the encrypted secret columns,
    // and a bug there would silently disconnect the integration.
    const list = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await list.json()) as {
      credentials: Array<{ service: string; type: string }>;
    };
    expect(credentials.find((c) => c.service === SERVICE)).toMatchObject({
      service: SERVICE,
      type: "oauth2",
    });
  });

  it("drops a duplicate folder id", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const put = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: ["fold-A", "fold-A", "fold-B"] }),
    });
    expect(await put.json()).toEqual({ folderIds: ["fold-A", "fold-B"] });
  });

  it("removes the restriction on DELETE", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);
    await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: ["fold-A"] }),
    });

    const del = await fetch(scopeUrl(api.baseUrl), { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ folderIds: null });

    const get = await fetch(scopeUrl(api.baseUrl));
    expect(await get.json()).toEqual({ folderIds: null });
  });

  it("stores an empty list as deny-everything rather than treating it as unset", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const put = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: [] }),
    });
    expect(await put.json()).toEqual({ folderIds: [] });

    const get = await fetch(scopeUrl(api.baseUrl));
    // Reading this back as null would silently widen access to the whole
    // Drive. DELETE is how a person removes the restriction.
    expect(await get.json()).toEqual({ folderIds: [] });
  });

  it("rejects an id that could break out of a Drive query", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    for (const bad of ["fold' or '1'='1", "has space", "../etc", ""]) {
      const put = await fetch(scopeUrl(api.baseUrl), {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ folderIds: [bad] }),
      });
      expect(put.status).toBe(400);
      const body = (await put.json()) as { error?: string; corrective?: string };
      expect(body.corrective).toContain("/folders/");
      // The web client renders `error` verbatim and drops `corrective`, so
      // the fix has to be inside `error` too or the reader never sees it.
      expect(body.error).toContain("/folders/");
    }
  });

  it("400s on a non-array body and on too many folders", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const notArray = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: "fold-A" }),
    });
    expect(notArray.status).toBe(400);

    const tooMany = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: Array.from({ length: 51 }, (_, i) => `fold${i}`) }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("404s with a corrective when Google Workspace is not connected", async () => {
    api = await bootTestApi();

    const put = await fetch(scopeUrl(api.baseUrl), {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ folderIds: ["fold-A"] }),
    });
    expect(put.status).toBe(404);
    const body = (await put.json()) as { error?: string; corrective?: string };
    expect(body.corrective).toContain("Connect Google Workspace");
    expect(body.error).toContain("Connect Google Workspace");
  });

  it("400s for a service that has no folder scope", async () => {
    api = await bootTestApi();

    const res = await fetch(scopeUrl(api.baseUrl, "github"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/credentials/:service/drive-folders", () => {
  it("lists only folders, under the requested parent", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      new Proxy(fetch, {
        apply(target, thisArg, args: [string | URL, RequestInit?]) {
          const url = String(args[0]);
          if (url.startsWith("https://www.googleapis.com/")) {
            calls.push(url);
            return Promise.resolve(
              new Response(JSON.stringify({ files: [{ id: "f1", name: "Finance" }] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          }
          return Reflect.apply(target, thisArg, args) as Promise<Response>;
        },
      }),
    );

    const res = await fetch(`${api.baseUrl}/api/credentials/${SERVICE}/drive-folders?parentId=fold-A`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ parentId: "fold-A", folders: [{ id: "f1", name: "Finance" }] });

    const query = decodeURIComponent(calls[0].replace(/\+/g, " "));
    expect(query).toContain("'fold-A' in parents");
    // A scope names folders, so offering files would imply they are pickable.
    expect(query).toContain("mimeType='application/vnd.google-apps.folder'");
  });

  it("rejects a parentId that is not a Drive id", async () => {
    api = await bootTestApi();
    await connectDrive(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/credentials/${SERVICE}/drive-folders?parentId=not%20an%20id`);
    expect(res.status).toBe(400);
  });
});
