/**
 * Outbound URL guard for admin-configured endpoints (SSRF defense).
 *
 * An org admin can point Valet at a URL that the api then calls from inside
 * the cluster: an LLM provider base URL today. A URL that reaches link-local
 * (cloud metadata), loopback, private networks, cluster DNS, or the instance
 * itself turns that admin setting into a request forgery primitive. The
 * guard runs at two points:
 *
 * 1. Save time: `checkOutboundUrl` refuses the URL by shape (scheme, literal
 *    address, internal host name) and by its current DNS answers.
 * 2. Request time: `guardedFetch` checks the shape of every hop, checks each
 *    DNS answer at connect time (so a re-pointed name cannot rebind to an
 *    internal address after the save-time check), and follows redirects by
 *    hand so that a public host cannot bounce the request inward.
 *
 * Operators allow legitimate self-hosted endpoints with
 * `VALET_OUTBOUND_URL_ALLOWLIST`: comma-separated host names (`llm.corp.example`),
 * host suffixes (`*.corp.example`), and CIDR ranges (`10.20.0.0/16`).
 * `VALET_INTERNAL_HOSTS` adds host names or addresses to block in addition
 * to the built-in rules.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { metrics } from "@opentelemetry/api";
import { Readable } from "node:stream";
import type { Dispatcher } from "undici";
// Import only undici's Agent and its request API (types in
// `types/undici-parts.d.ts`). The package root, and its fetch, register an
// Agent as the process-wide dispatcher on load, and Node's built-in fetch
// then sends every request in the api through it. This module must not
// change global fetch.
import Agent from "undici/lib/dispatcher/agent.js";
import { request as undiciRequest } from "undici/lib/api/index.js";

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

// One list per family: a BlockList checks IPv4 addresses against IPv6 rules
// in their IPv4-mapped form, so `::ffff:0:0/96` in a shared list would match
// every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of BLOCKED_V4) blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of BLOCKED_V6) blockedV6.addSubnet(network, prefix, "ipv6");

/** Host-name suffixes that only resolve inside a cluster, a host, or a
 * private network. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".cluster.local", ".svc", ".home.arpa"];

const ALLOWLIST_ENV = "VALET_OUTBOUND_URL_ALLOWLIST";
const MAX_REDIRECTS = 5;

export interface OutboundPolicy {
  /** Exact host names (lowercase, no trailing dot) that skip every check. */
  allowHosts: ReadonlySet<string>;
  /** Host suffixes (leading dot) that skip every check. */
  allowSuffixes: readonly string[];
  /** Address ranges that resolved addresses may fall in, per family. */
  allowRanges: { v4: BlockList; v6: BlockList };
  /** Host names and literal addresses of the instance itself and its
   * internal services. */
  internalHosts: ReadonlySet<string>;
}

export type OutboundCheck = { ok: true } | { ok: false; reason: string };

export class OutboundUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OutboundUrlError";
  }
}

type Counter = ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
let refusalCounter: Counter | undefined;

/** Counts refused outbound URLs by stage (`save`, `request`, `redirect`).
 * A burst of save-time refusals is the signature of an admin account probing
 * internal targets and needs a human. */
export function recordOutboundRefusal(stage: "save" | "request" | "redirect"): void {
  refusalCounter ??= metrics.getMeter("@valet/api").createCounter("valet.security.outbound_url_refused", {
    description: "Admin-configured outbound URLs refused by the SSRF guard, by stage",
  });
  refusalCounter.add(1, { stage });
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function hostOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return normalizeHost(new URL(raw).hostname);
  } catch {
    return undefined;
  }
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Builds the policy from the environment. Throws on a malformed allowlist
 * entry so that a typo fails at boot, not as a silent refusal. */
export function outboundPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  const allowHosts = new Set<string>();
  const allowSuffixes: string[] = [];
  const allowRanges = { v4: new BlockList(), v6: new BlockList() };
  for (const entry of splitList(env[ALLOWLIST_ENV])) {
    const slash = entry.indexOf("/");
    if (slash !== -1) {
      const network = entry.slice(0, slash);
      const prefix = Number(entry.slice(slash + 1));
      const family = isIP(network);
      if (family === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
        throw new Error(`${ALLOWLIST_ENV} entry "${entry}" is not a valid CIDR range. Use a form such as 10.20.0.0/16.`);
      }
      if (family === 4) allowRanges.v4.addSubnet(network, prefix, "ipv4");
      else allowRanges.v6.addSubnet(network, prefix, "ipv6");
    } else if (entry.startsWith("*.")) {
      allowSuffixes.push(entry.slice(1));
    } else if (isIP(entry) !== 0) {
      if (isIP(entry) === 4) allowRanges.v4.addAddress(entry, "ipv4");
      else allowRanges.v6.addAddress(entry, "ipv6");
      allowHosts.add(entry);
    } else {
      allowHosts.add(normalizeHost(entry));
    }
  }

  const internalHosts = new Set<string>(splitList(env.VALET_INTERNAL_HOSTS).map(normalizeHost));
  // The instance's own public names: a provider that points back at Valet
  // would loop through, and could reflect, its own routes.
  for (const raw of [env.VALET_PUBLIC_URL, env.BETTER_AUTH_URL]) {
    const host = hostOf(raw);
    if (host) internalHosts.add(host);
  }
  // Kubernetes injects `<SERVICE>_SERVICE_HOST` for every service in the
  // namespace, plus the API server address. Block all of them by address.
  for (const [key, value] of Object.entries(env)) {
    if (key.endsWith("_SERVICE_HOST") && value) internalHosts.add(normalizeHost(value));
  }
  return { allowHosts, allowSuffixes, allowRanges, internalHosts };
}

let cachedPolicy: { key: string; policy: OutboundPolicy } | undefined;

/** The process policy, rebuilt when the relevant environment changes. */
export function currentOutboundPolicy(): OutboundPolicy {
  const env = process.env;
  const key = [env[ALLOWLIST_ENV], env.VALET_INTERNAL_HOSTS, env.VALET_PUBLIC_URL, env.BETTER_AUTH_URL].join("\u0000");
  if (cachedPolicy?.key !== key) cachedPolicy = { key, policy: outboundPolicyFromEnv(env) };
  return cachedPolicy.policy;
}

function hostAllowlisted(host: string, policy: OutboundPolicy): boolean {
  return policy.allowHosts.has(host) || policy.allowSuffixes.some((suffix) => host.endsWith(suffix));
}

function addressAllowed(address: string, policy: OutboundPolicy): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? "ipv4" : "ipv6";
  if ((family === 4 ? policy.allowRanges.v4 : policy.allowRanges.v6).check(address, type)) return true;
  if (policy.internalHosts.has(normalizeHost(address))) return false;
  return !(family === 4 ? blockedV4 : blockedV6).check(address, type);
}

const ALLOWLIST_HINT = `Use a public endpoint, or ask the instance operator to add the host to ${ALLOWLIST_ENV}.`;

function refuse(reason: string): OutboundCheck {
  return { ok: false, reason: `${reason} ${ALLOWLIST_HINT}` };
}

/** Checks a URL without DNS: scheme, literal addresses, and host names that
 * name internal targets. */
export function checkOutboundUrlShape(raw: string, policy: OutboundPolicy = currentOutboundPolicy()): OutboundCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "The URL is not valid. Enter a full URL such as https://llm.example.com/v1." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "The URL must use https or http." };
  }
  // WHATWG URL parsing already folds decimal, octal, and short IPv4 forms
  // (2130706433, 0x7f.1, 127.1) into dotted quads.
  const host = normalizeHost(url.hostname);
  if (hostAllowlisted(host, policy)) return { ok: true };
  if (isIP(host) !== 0) {
    return addressAllowed(host, policy)
      ? { ok: true }
      : refuse(`The URL points at ${host}, a private, loopback, link-local, or internal address.`);
  }
  if (policy.internalHosts.has(host)) {
    return refuse(`The URL points at ${host}, a host of this Valet instance.`);
  }
  // A single-label name resolves through the cluster or host search domains
  // (for example "valet-api" or "kubernetes").
  if (!host.includes(".")) {
    return refuse(`The URL host "${host}" is not a fully qualified public name.`);
  }
  if (host.startsWith("kubernetes.default") || /\.svc(\.|$)/.test(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return refuse(`The URL host "${host}" names an internal or cluster service.`);
  }
  return { ok: true };
}

export type Resolver = (host: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/** Save-time check: the shape check plus the host's current DNS answers.
 * Every answer must be allowed. A name that does not resolve yet passes,
 * because `guardedFetch` checks the answers again at connect time. */
export async function checkOutboundUrl(
  raw: string,
  policy: OutboundPolicy = currentOutboundPolicy(),
  resolve: Resolver = systemResolver,
): Promise<OutboundCheck> {
  const shape = checkOutboundUrlShape(raw, policy);
  if (!shape.ok) return shape;
  const host = normalizeHost(new URL(raw).hostname);
  if (hostAllowlisted(host, policy) || isIP(host) !== 0) return { ok: true };
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: true };
  }
  const blocked = addresses.find((entry) => !addressAllowed(entry.address, policy));
  return blocked
    ? refuse(`The URL host "${host}" resolves to ${blocked.address}, a private, loopback, link-local, or internal address.`)
    : { ok: true };
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `net.connect` lookup that refuses any internal answer for a host that
 * is not allowlisted. This is the check that defeats DNS rebinding. */
export function guardedLookup(policy: OutboundPolicy, resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    const host = normalizeHost(hostname);
    resolve(host).then(
      (addresses) => {
        if (!hostAllowlisted(host, policy)) {
          const blocked = addresses.find((entry) => !addressAllowed(entry.address, policy));
          if (blocked) {
            recordOutboundRefusal("request");
            const err: NodeJS.ErrnoException = new OutboundUrlError(
              `Refused to connect to "${host}": it resolves to ${blocked.address}, a private, loopback, link-local, or internal address. ${ALLOWLIST_HINT}`,
            );
            err.code = "EOUTBOUNDREFUSED";
            callback(err, []);
            return;
          }
        }
        const first = addresses[0];
        if (!first) {
          const err: NodeJS.ErrnoException = new Error(`No address found for "${host}".`);
          err.code = "ENOTFOUND";
          callback(err, []);
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, []),
    );
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key", "api-key"];

/**
 * Buffers a request body so a 307 or 308 redirect can send it again. A body
 * type that implies a content type (form data, URL params, a typed blob)
 * keeps it. Model requests are small JSON strings, so buffering costs little.
 */
async function bufferedBody(body: RequestInit["body"] | ArrayBuffer, headers: Headers): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  const wrapped = new Response(body);
  const implied = wrapped.headers.get("content-type");
  if (implied && !headers.has("content-type")) headers.set("content-type", implied);
  return new Uint8Array(await wrapped.arrayBuffer());
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Builds a fetch that applies the policy to every hop. It is a drop-in
 * `fetch` for SDKs that accept one (the OpenAI client inside pi-ai).
 * Redirects are followed by hand, up to five hops; each hop gets the shape
 * check, the connect-time DNS check, and loses credential headers when it
 * leaves the original origin.
 */
export function createGuardedFetch(policy?: OutboundPolicy, resolve: Resolver = systemResolver): typeof fetch {
  let agent: { policy: OutboundPolicy; dispatcher: Dispatcher } | undefined;
  const dispatcherFor = (active: OutboundPolicy): Dispatcher => {
    if (agent?.policy !== active) {
      agent = { policy: active, dispatcher: new Agent({ connect: { lookup: guardedLookup(active, resolve) } }) };
    }
    return agent.dispatcher;
  };

  return async (input, init) => {
    const active = policy ?? currentOutboundPolicy();
    const dispatcher = dispatcherFor(active);
    const request = input instanceof Request ? input : undefined;
    let url = urlOf(input);
    let method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    let body = await bufferedBody(init?.body ?? (request ? await request.arrayBuffer() : undefined), headers);
    const signal = init?.signal ?? request?.signal;
    const origin = new URL(url).origin;
    // The dispatcher does not decompress responses, so ask for identity
    // encoding. It also sets content-length from the buffered body.
    headers.delete("accept-encoding");
    headers.delete("content-length");

    for (let hop = 0; ; hop++) {
      const check = checkOutboundUrlShape(url, active);
      if (!check.ok) {
        recordOutboundRefusal(hop === 0 ? "request" : "redirect");
        throw new OutboundUrlError(hop === 0 ? check.reason : `Refused a redirect to ${url}. ${check.reason}`);
      }
      const target = new URL(url);
      let response: Dispatcher.ResponseData<unknown>;
      try {
        response = await undiciRequest.call(dispatcher, {
          origin: target.origin,
          path: `${target.pathname}${target.search}`,
          // The cast narrows the free-form method string to undici's union;
          // undici sends the method token as given.
          method: method as Dispatcher.HttpMethod,
          headers: Object.fromEntries(headers),
          body,
          signal: signal ?? undefined,
        });
      } catch (err) {
        if (err instanceof Error && err.cause instanceof OutboundUrlError) throw err.cause;
        throw err;
      }
      const status = response.statusCode;
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const location = responseHeaders.get("location");
      if (!REDIRECT_STATUSES.has(status) || !location) {
        const noBody = status === 204 || status === 205 || status === 304 || method === "HEAD";
        if (noBody) response.body.resume();
        return new Response(noBody ? null : Readable.toWeb(response.body), { status, headers: responseHeaders });
      }
      if (hop >= MAX_REDIRECTS) {
        throw new OutboundUrlError(`Stopped after ${MAX_REDIRECTS} redirects from ${origin}. Check the endpoint URL.`);
      }
      response.body.resume();
      url = new URL(location, url).href;
      if (new URL(url).origin !== origin) {
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      }
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
    }
  };
}

/** The process-wide guarded fetch, bound to `currentOutboundPolicy()`. */
export const guardedFetch: typeof fetch = createGuardedFetch();

/** pi-ai adapters that refuse a custom fetch. Their endpoints come from the
 * pi-ai registry or the deployment, never from an admin-set base URL (the
 * provider API refuses a base URL on known kinds). */
const NO_CUSTOM_FETCH_APIS = new Set(["google-generative-ai", "google-vertex"]);

/** The fetch for one model request: `guardedFetch`, or undefined (pi-ai's
 * default) for an adapter that refuses a custom fetch. */
export function modelFetchFor(model: { api: string }): typeof fetch | undefined {
  return NO_CUSTOM_FETCH_APIS.has(model.api) ? undefined : guardedFetch;
}
