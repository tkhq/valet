/**
 * Package facts the public registries give cheaply: license, publish dates,
 * publishers and install scripts. One or two reads per package, capped per
 * run. A failed read gives no facts for that package: these checks are best
 * effort, and the advisory check does not depend on them.
 *
 * - npm: the version document (license, install scripts, maintainers,
 *   publisher), and for an added package the package document (creation date).
 * - crates.io: the crate document (creation date, each version's license and publisher).
 * - PyPI: the version document (license, upload date), and for an added package the project document.
 * - Go: the module proxy (version date, earliest version). The proxy has no license or publisher.
 */
import type { Ecosystem } from "./parse.js";

export interface PackageFacts {
  license?: string;
  /** The package's first publish. */
  createdAt?: string;
  /** This version's publish. */
  publishedAt?: string;
  /** Who published this version (npm `_npmUser`, crates.io `published_by`). */
  publisher?: string;
  /** npm maintainers of this version. */
  maintainers?: string[];
  /** The install-time scripts this version runs (npm `preinstall`, `install`, `postinstall`). */
  installScripts?: Record<string, string>;
}

export interface RegistryRequest {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Read the package's creation date too. Costs a larger read on npm and PyPI. */
  created: boolean;
}

/** A package document larger than this is not read: a package with that much history is not new. */
const MAX_DOC_BYTES = 4_000_000;
const USER_AGENT = "valet-dependency-review (https://github.com/tkhq/valet)";

export interface RegistryUrls {
  npm: string;
  crates: string;
  pypi: string;
  goproxy: string;
}

export const REGISTRY_URLS: RegistryUrls = {
  npm: "https://registry.npmjs.org",
  crates: "https://crates.io/api/v1",
  pypi: "https://pypi.org/pypi",
  goproxy: "https://proxy.golang.org",
};

export async function packageFacts(req: RegistryRequest, opts: { fetch?: typeof fetch; signal?: AbortSignal; urls?: RegistryUrls } = {}): Promise<PackageFacts | undefined> {
  const doFetch = opts.fetch ?? fetch;
  const urls = opts.urls ?? REGISTRY_URLS;
  const text = async (url: string): Promise<string | undefined> => {
    const res = await doFetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!res.ok) return undefined;
    if (Number(res.headers.get("content-length") ?? "0") > MAX_DOC_BYTES) {
      await res.body?.cancel();
      return undefined;
    }
    const body = await res.text();
    return body.length > MAX_DOC_BYTES ? undefined : body;
  };
  const get: Get = Object.assign(
    async <T>(url: string): Promise<T | undefined> => {
      const body = await text(url);
      return body === undefined ? undefined : (JSON.parse(body) as T); // registry documents; callers read optional fields only
    },
    { text },
  );
  try {
    switch (req.ecosystem) {
      case "npm":
        return await npmFacts(get, urls.npm, req);
      case "crates.io":
        return await cratesFacts(get, urls.crates, req);
      case "PyPI":
        return await pypiFacts(get, urls.pypi, req);
      case "Go":
        return await goFacts(get, urls.goproxy, req);
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    console.warn(`dependency review: registry read of ${req.ecosystem} ${req.name}@${req.version} failed`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

type Get = (<T>(url: string) => Promise<T | undefined>) & { text: (url: string) => Promise<string | undefined> };

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

async function npmFacts(get: Get, base: string, req: RegistryRequest): Promise<PackageFacts | undefined> {
  const name = req.name.startsWith("@") ? `@${encodeURIComponent(req.name.slice(1))}` : encodeURIComponent(req.name);
  type Version = { license?: string | { type?: string }; scripts?: Record<string, string>; maintainers?: { name?: string }[]; _npmUser?: { name?: string } };
  const [doc, pkg] = await Promise.all([
    get<Version>(`${base}/${name}/${encodeURIComponent(req.version)}`),
    req.created ? get<{ time?: Record<string, string> }>(`${base}/${name}`) : Promise.resolve(undefined),
  ]);
  if (!doc) return undefined;
  const scripts = Object.fromEntries(Object.entries(doc.scripts ?? {}).filter(([k]) => INSTALL_SCRIPTS.includes(k)));
  const license = typeof doc.license === "string" ? doc.license : doc.license?.type;
  return {
    ...(license ? { license } : {}),
    ...(pkg?.time?.created ? { createdAt: pkg.time.created } : {}),
    ...(pkg?.time?.[req.version] ? { publishedAt: pkg.time[req.version] } : {}),
    ...(doc._npmUser?.name ? { publisher: doc._npmUser.name } : {}),
    maintainers: (doc.maintainers ?? []).map((m) => m.name ?? "").filter(Boolean).sort(),
    installScripts: scripts,
  };
}

async function cratesFacts(get: Get, base: string, req: RegistryRequest): Promise<PackageFacts | undefined> {
  type Doc = { crate?: { created_at?: string }; versions?: { num: string; license?: string | null; created_at?: string; published_by?: { login?: string } | null }[] };
  const doc = await get<Doc>(`${base}/crates/${encodeURIComponent(req.name)}`);
  const v = doc?.versions?.find((x) => x.num === req.version);
  if (!doc || !v) return undefined;
  return {
    ...(v.license ? { license: v.license } : {}),
    ...(doc.crate?.created_at ? { createdAt: doc.crate.created_at } : {}),
    ...(v.created_at ? { publishedAt: v.created_at } : {}),
    ...(v.published_by?.login ? { publisher: v.published_by.login } : {}),
  };
}

async function pypiFacts(get: Get, base: string, req: RegistryRequest): Promise<PackageFacts | undefined> {
  type Doc = { info?: { license?: string | null; license_expression?: string | null }; urls?: { upload_time_iso_8601?: string; upload_time?: string }[]; releases?: Record<string, { upload_time_iso_8601?: string }[]> };
  const [doc, project] = await Promise.all([
    get<Doc>(`${base}/${encodeURIComponent(req.name)}/${encodeURIComponent(req.version)}/json`),
    req.created ? get<Doc>(`${base}/${encodeURIComponent(req.name)}/json`) : Promise.resolve(undefined),
  ]);
  if (!doc) return undefined;
  // `license` is free text and sometimes the whole license file: keep it only when it is short.
  const raw = doc.info?.license_expression ?? doc.info?.license ?? undefined;
  const license = raw && raw.length <= 60 && !raw.includes("\n") ? raw : undefined;
  const uploads = Object.values(project?.releases ?? {}).flat().map((f) => f.upload_time_iso_8601).filter((t): t is string => typeof t === "string").sort();
  const published = doc.urls?.map((u) => u.upload_time_iso_8601 ?? u.upload_time).find((t): t is string => typeof t === "string");
  return {
    ...(license ? { license } : {}),
    ...(uploads[0] ? { createdAt: uploads[0] } : {}),
    ...(published ? { publishedAt: published } : {}),
  };
}

async function goFacts(get: Get, base: string, req: RegistryRequest): Promise<PackageFacts | undefined> {
  // The proxy escapes capital letters as `!` plus the lowercase letter.
  const mod = req.name.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
  const info = await get<{ Time?: string }>(`${base}/${mod}/@v/${req.version}.info`);
  if (!info) return undefined;
  let createdAt: string | undefined;
  if (req.created) {
    const list = await get.text(`${base}/${mod}/@v/list`);
    const first = list?.split("\n").map((s) => s.trim()).filter(Boolean).sort(semverOrder)[0];
    if (first) createdAt = first === req.version ? info.Time : (await get<{ Time?: string }>(`${base}/${mod}/@v/${first}.info`))?.Time;
  }
  return { ...(info.Time ? { publishedAt: info.Time } : {}), ...(createdAt ? { createdAt } : {}) };
}

function semverOrder(a: string, b: string): number {
  const key = (v: string): number[] => v.replace(/^v/, "").split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
