import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkOutboundUrl,
  checkOutboundUrlShape,
  createGuardedFetch,
  outboundPolicyFromEnv,
  OutboundUrlError,
  type Resolver,
} from "./outbound-url.js";

const empty = outboundPolicyFromEnv({});

function refused(url: string, policy = empty): string {
  const check = checkOutboundUrlShape(url, policy);
  if (check.ok) throw new Error(`expected ${url} to be refused`);
  return check.reason;
}

describe("checkOutboundUrlShape", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:80/",
    "https://127.0.0.1:443/v1",
    "http://127.0.0.1:3000/",
    "http://127.0.0.1:8080/",
    "http://10.0.0.1/v1",
    "http://10.61.16.144:8787/",
    "http://172.16.5.5/",
    "http://192.168.1.10/",
    "http://100.64.1.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://127.1/",
  ])("refuses the internal address in %s", (url) => {
    expect(refused(url)).toMatch(/private, loopback, link-local, or internal address/);
  });

  it.each([
    "https://kubernetes.default.svc/api",
    "https://kubernetes.default/api",
    "https://kubernetes.default.svc.cluster.local/",
    "http://valet-api.valet.svc.cluster.local:8787/",
    "http://registry.valet-sandboxes.svc:5000/v2/",
    "http://metadata.google.internal/",
    "http://ip-10-0-0-1.ec2.internal/",
    "http://foo.localhost/",
    "http://printer.local/",
  ])("refuses the cluster or internal name in %s", (url) => {
    expect(refused(url)).toMatch(/internal or cluster service/);
  });

  it.each(["http://localhost:8080/", "http://localhost./", "http://valet-api:8787/", "http://kubernetes/"])(
    "refuses the single-label name in %s",
    (url) => {
      expect(refused(url)).toMatch(/not a fully qualified public name/);
    },
  );

  it("refuses schemes other than http and https, and names the fix", () => {
    expect(refused("file:///etc/passwd")).toBe("The URL must use https or http.");
    expect(refused("ftp://llm.example.com/")).toBe("The URL must use https or http.");
    expect(refused("not a url")).toMatch(/Enter a full URL/);
  });

  it("names the allowlist in every address refusal", () => {
    expect(refused("http://169.254.169.254/")).toContain("VALET_OUTBOUND_URL_ALLOWLIST");
  });

  it.each(["https://api.openai.com/v1", "https://llm.example.com/v1", "http://8.8.8.8/", "https://172.66.147.243/", "https://[2606:4700::1]/"])(
    "accepts the public URL %s",
    (url) => {
      expect(checkOutboundUrlShape(url, empty)).toEqual({ ok: true });
    },
  );

  it("refuses the instance's own hosts and Kubernetes service addresses", () => {
    const policy = outboundPolicyFromEnv({
      VALET_PUBLIC_URL: "https://valet.corp.example",
      BETTER_AUTH_URL: "https://auth-valet.corp.example/api/auth",
      KUBERNETES_SERVICE_HOST: "172.20.0.1",
      VALET_REGISTRY_SERVICE_HOST: "203.0.113.200",
      VALET_INTERNAL_HOSTS: "ecr-proxy.corp.example, 198.51.100.7",
    });
    expect(refused("https://valet.corp.example/api/proxy", policy)).toMatch(/a host of this Valet instance/);
    expect(refused("https://auth-valet.corp.example/", policy)).toMatch(/a host of this Valet instance/);
    expect(refused("https://ecr-proxy.corp.example/v2/", policy)).toMatch(/a host of this Valet instance/);
    expect(refused("https://172.20.0.1/", policy)).toMatch(/internal address/);
    expect(refused("http://198.51.100.7/", policy)).toMatch(/internal address/);
  });

  it("lets the operator allowlist exact hosts, suffixes, and ranges", () => {
    const policy = outboundPolicyFromEnv({
      VALET_OUTBOUND_URL_ALLOWLIST: "llm.svc, *.models.internal, 10.20.0.0/16, 127.0.0.1",
    });
    expect(checkOutboundUrlShape("http://llm.svc/v1", policy)).toEqual({ ok: true });
    expect(checkOutboundUrlShape("http://vllm.models.internal/v1", policy)).toEqual({ ok: true });
    expect(checkOutboundUrlShape("http://10.20.3.4:8000/v1", policy)).toEqual({ ok: true });
    expect(checkOutboundUrlShape("http://127.0.0.1:8000/v1", policy)).toEqual({ ok: true });
    expect(refused("http://10.21.0.1/v1", policy)).toMatch(/internal address/);
    expect(refused("http://169.254.169.254/", policy)).toMatch(/internal address/);
  });

  it("fails at boot on a malformed allowlist range", () => {
    expect(() => outboundPolicyFromEnv({ VALET_OUTBOUND_URL_ALLOWLIST: "10.0.0.0/40" })).toThrow(
      /not a valid CIDR range\. Use a form such as 10\.20\.0\.0\/16/,
    );
  });
});

function resolverFor(table: Record<string, string[]>): Resolver {
  return async (host) => {
    const addresses = table[host];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

describe("checkOutboundUrl (DNS answers)", () => {
  it("refuses a public-looking name that resolves to cloud metadata", async () => {
    const check = await checkOutboundUrl("https://llm.attacker.example/v1", empty, resolverFor({ "llm.attacker.example": ["169.254.169.254"] }));
    expect(check).toEqual({ ok: false, reason: expect.stringContaining("resolves to 169.254.169.254") });
  });

  it("refuses when any one answer is internal", async () => {
    const check = await checkOutboundUrl(
      "https://llm.attacker.example/v1",
      empty,
      resolverFor({ "llm.attacker.example": ["93.184.216.34", "10.0.0.1"] }),
    );
    expect(check.ok).toBe(false);
  });

  it("accepts public answers, and an allowlisted range", async () => {
    expect(await checkOutboundUrl("https://llm.example.com/v1", empty, resolverFor({ "llm.example.com": ["93.184.216.34"] }))).toEqual({ ok: true });
    const policy = outboundPolicyFromEnv({ VALET_OUTBOUND_URL_ALLOWLIST: "10.20.0.0/16" });
    expect(await checkOutboundUrl("https://vllm.corp.example/v1", policy, resolverFor({ "vllm.corp.example": ["10.20.1.1"] }))).toEqual({ ok: true });
  });

  it("accepts a name that does not resolve yet, because connect time checks it again", async () => {
    expect(await checkOutboundUrl("https://new.example.com/v1", empty, resolverFor({}))).toEqual({ ok: true });
  });
});

describe("createGuardedFetch", () => {
  let server: Server;
  let port: number;
  const seen: Array<{ host: string | undefined; method: string | undefined; path: string | undefined; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ host: req.headers.host, method: req.method, path: req.url, headers: req.headers });
      const location = new URL(req.url ?? "/", "http://x.example").searchParams.get("to");
      if (req.url?.startsWith("/redirect") && location) {
        res.writeHead(req.url.startsWith("/redirect303") ? 303 : 302, { location });
        res.end();
        return;
      }
      if (req.url?.startsWith("/loop")) {
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Every test name resolves to the loopback fixture. Only the allowlisted
  // names may connect; the others model a public name rebound inward.
  const resolve = resolverFor({ "a.test": ["127.0.0.1"], "b.test": ["127.0.0.1"], "rebind.test": ["127.0.0.1"] });
  const policy = outboundPolicyFromEnv({ VALET_OUTBOUND_URL_ALLOWLIST: "a.test,b.test" });
  const guarded = () => createGuardedFetch(policy, resolve);

  it("connects to an allowlisted host", async () => {
    const res = await guarded()(`http://a.test:${port}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("refuses at connect time when a name resolves to an internal address (DNS rebinding)", async () => {
    await expect(guarded()(`http://rebind.test:${port}/`)).rejects.toThrow(OutboundUrlError);
    await expect(guarded()(`http://rebind.test:${port}/`)).rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it("refuses a literal internal address before it connects", async () => {
    await expect(guarded()("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/internal address/);
  });

  it("refuses a redirect to cloud metadata", async () => {
    const to = encodeURIComponent("http://169.254.169.254/latest/meta-data/iam/");
    await expect(guarded()(`http://a.test:${port}/redirect?to=${to}`)).rejects.toThrow(/Refused a redirect to http:\/\/169\.254\.169\.254/);
  });

  it("refuses a redirect to a name that rebinds inward", async () => {
    const to = encodeURIComponent(`http://rebind.test:${port}/`);
    await expect(guarded()(`http://a.test:${port}/redirect?to=${to}`)).rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it("drops credential headers on a cross-origin redirect and keeps them on the same origin", async () => {
    seen.length = 0;
    const to = encodeURIComponent(`http://b.test:${port}/final`);
    const res = await guarded()(`http://a.test:${port}/redirect?to=${to}`, { headers: { authorization: "Bearer sk-secret", "x-api-key": "sk-secret" } });
    expect(res.status).toBe(200);
    expect(seen.map((r) => r.path)).toEqual([`/redirect?to=${to}`, "/final"]);
    expect(seen[0]?.headers.authorization).toBe("Bearer sk-secret");
    expect(seen[1]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.headers["x-api-key"]).toBeUndefined();

    seen.length = 0;
    const same = encodeURIComponent("/final");
    await guarded()(`http://a.test:${port}/redirect?to=${same}`, { headers: { authorization: "Bearer sk-secret" } });
    expect(seen[1]?.headers.authorization).toBe("Bearer sk-secret");
  });

  it("turns a 303 after a POST into a GET without the body", async () => {
    seen.length = 0;
    const to = encodeURIComponent("/final");
    const res = await guarded()(`http://a.test:${port}/redirect303?to=${to}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    expect(seen.map((r) => r.method)).toEqual(["POST", "GET"]);
    expect(seen[1]?.headers["content-type"]).toBeUndefined();
  });

  it("stops after five redirects", async () => {
    await expect(guarded()(`http://a.test:${port}/loop`)).rejects.toThrow(/Stopped after 5 redirects/);
  });
});
