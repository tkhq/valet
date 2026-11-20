/**
 * Dependency findings: what the handler posts for each changed package.
 * One pure function turns the package changes, their advisories and their
 * registry facts into findings. Each finding has a stable `key`, so a later
 * push keeps, resolves or adds findings by key.
 */
import type { PackageChange, PackageLocation } from "./diff.js";
import type { Advisory } from "./osv.js";
import type { PackageFacts } from "./registry.js";
import { licenseClass, sameLicense, typosquatOf } from "./signals.js";

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITY_ORDER: readonly Severity[] = ["low", "medium", "high", "critical"];

export type DependencyFindingKind = "advisory" | "typosquat" | "install-script" | "new-package" | "maintainer" | "license";

export interface DependencyFinding {
  /** `<ecosystem>:<name>@<version>:<kind>[:<advisory id>]`: the same issue on a later push has the same key. */
  key: string;
  kind: DependencyFindingKind;
  severity: Severity;
  title: string;
  body: string;
  ecosystem: PackageChange["ecosystem"];
  name: string;
  version: string;
  direct: boolean;
  /** Where to anchor it, best first. Empty: the summary only. */
  locations: PackageLocation[];
  /** Set for an advisory finding. */
  advisory?: Advisory;
}

/** Registry facts per change, for its head version and for its base version on an upgrade or downgrade. */
export interface ChangeFacts {
  to?: PackageFacts;
  from?: PackageFacts;
}

export interface FindingOptions {
  /** A package first published fewer days ago than this counts as new. */
  newPackageDays: number;
  /** The time the run checks against. */
  now: Date;
}

const DAY_MS = 86_400_000;

/**
 * The findings for `changes`, in the order of `changes`. `advisories[i]` and
 * `facts[i]` belong to `changes[i]`. A removed package gets none. Findings of
 * one package in several files merge into one (the first location wins, the
 * others follow it).
 */
export function dependencyFindings(changes: PackageChange[], advisories: Advisory[][], facts: ChangeFacts[], opts: FindingOptions): DependencyFinding[] {
  const byKey = new Map<string, DependencyFinding>();
  const add = (f: DependencyFinding): void => {
    const same = byKey.get(f.key);
    if (!same) return void byKey.set(f.key, f);
    for (const loc of f.locations) if (!same.locations.some((l) => l.path === loc.path && l.line === loc.line)) same.locations.push(loc);
    same.direct ||= f.direct;
  };
  changes.forEach((c, i) => {
    if (c.kind === "removed" || c.to === undefined) return;
    const version = c.to;
    const pkg = `${c.name} ${version}`;
    const base = { ecosystem: c.ecosystem, name: c.name, version, direct: c.direct, locations: [...c.locations] };
    const key = (kind: DependencyFindingKind, extra?: string): string => `${c.ecosystem}:${c.name}@${version}:${kind}${extra ? `:${extra}` : ""}`;
    const where = `${c.direct ? "a direct" : "a transitive"} dependency${c.kind === "added" ? "" : `, ${c.kind} from ${c.from}`}`;
    const range = c.exact ? "" : ` (the lower bound of the declared range; the lockfile did not change, so the installed version may be higher)`;

    for (const a of advisories[i] ?? []) {
      const fix = a.fixed ? `Upgrade to ${a.fixed} or later.` : "OSV names no fixed version for this package.";
      add({
        ...base,
        key: key("advisory", a.id),
        kind: "advisory",
        severity: a.severity,
        advisory: a,
        title: `${pkg} has advisory ${a.id}: ${a.summary}`,
        body: [`This pull request adds ${pkg}${range}, ${where}. [${a.id}](${a.url})${a.aliases.length > 0 ? ` (${a.aliases.slice(0, 3).join(", ")})` : ""} affects this version. ${fix}`].join("\n"),
      });
    }

    const head = facts[i]?.to;
    const prev = facts[i]?.from;
    if (c.kind === "added") {
      const squat = typosquatOf(c.ecosystem, c.name);
      if (squat) {
        add({
          ...base,
          key: key("typosquat"),
          kind: "typosquat",
          severity: squat.how === "separator" ? "high" : "medium",
          title: `${c.name} is one ${squat.how === "separator" ? "separator" : "letter"} away from the popular package ${squat.of}`,
          body: `This pull request adds ${pkg}, ${where}. Its name differs from \`${squat.of}\` by ${squat.how === "separator" ? "separators or case only" : "one letter"}. A typosquat imitates a popular name to get installed by mistake. Confirm that \`${c.name}\` is the package you meant.`,
        });
      }
      const created = head?.createdAt ? Date.parse(head.createdAt) : Number.NaN;
      const ageDays = Math.floor((opts.now.getTime() - created) / DAY_MS);
      if (Number.isFinite(created) && ageDays < opts.newPackageDays) {
        add({
          ...base,
          key: key("new-package"),
          kind: "new-package",
          severity: "medium",
          title: `${c.name} was first published ${ageDays <= 0 ? "today" : `${ageDays} day(s) ago`}`,
          body: `This pull request adds ${pkg}, ${where}. The registry shows its first release on ${head?.createdAt?.slice(0, 10)}. A new package has no record yet, and most malicious packages are removed within days of release. Confirm its source before you merge.`,
        });
      }
    }

    // Install scripts: from the registry, or from the lockfile when the registry gave nothing.
    const scripts = head?.installScripts ? Object.keys(head.installScripts) : c.installScript ? ["install"] : [];
    const hadScripts = prev?.installScripts ? Object.keys(prev.installScripts).length > 0 : c.fromInstallScript === true;
    if (scripts.length > 0 && (c.kind === "added" || !hadScripts)) {
      const shown = head?.installScripts ? Object.entries(head.installScripts).map(([k, v]) => `\`${k}\`: \`${v.slice(0, 120)}\``).join("; ") : "an install-time build step (from the lockfile)";
      add({
        ...base,
        key: key("install-script"),
        kind: "install-script",
        severity: c.direct ? "medium" : "low",
        title: `${pkg} runs a script at install time`,
        body: `${c.kind === "added" ? `This pull request adds ${pkg}, ${where}.` : `${c.name} ${c.from} had no install script; ${version} has one.`} Every \`npm install\` runs ${shown} with the installing user's access. Read the script, or install with \`--ignore-scripts\`.`,
      });
    }

    if (c.kind !== "added" && prev && head) {
      const gained = (head.maintainers ?? []).filter((m) => !(prev.maintainers ?? []).includes(m));
      const publisherChanged = head.publisher !== undefined && prev.publisher !== undefined && head.publisher !== prev.publisher && !(prev.maintainers ?? []).includes(head.publisher);
      if (gained.length > 0 || publisherChanged) {
        add({
          ...base,
          key: key("maintainer"),
          kind: "maintainer",
          severity: gained.length > 0 ? "medium" : "low",
          title: `${c.name} ${version} ${gained.length > 0 ? `has new maintainer(s): ${gained.slice(0, 3).join(", ")}` : `was published by a new account, ${head.publisher}`}`,
          body: `${c.name} ${c.from} was published by ${prev.publisher ?? "an unknown account"}${prev.maintainers?.length ? ` with maintainers ${prev.maintainers.slice(0, 5).join(", ")}` : ""}. ${version} was published by ${head.publisher ?? "an unknown account"}${gained.length > 0 ? `, and adds maintainer(s) ${gained.slice(0, 5).join(", ")}` : ""}. A taken-over account is a common way to ship a malicious release. Check that the change of hands is known.`,
        });
      }
    }

    const toLicense = head?.license ?? c.license;
    const fromLicense = prev?.license ?? c.fromLicense;
    if (c.kind !== "added" && toLicense && fromLicense && !sameLicense(toLicense, fromLicense)) {
      const strong = licenseClass(toLicense) === "strong-copyleft";
      add({
        ...base,
        key: key("license"),
        kind: "license",
        severity: strong ? "high" : "medium",
        title: `${c.name} changes license from ${fromLicense} to ${toLicense}`,
        body: `${c.name} ${c.from} is licensed ${fromLicense}; ${version} is licensed ${toLicense}.${strong ? " The new license requires sharing source for code that uses it, including code served over a network." : ""} Check that the new terms are acceptable.`,
      });
    } else if (c.kind === "added" && c.direct && toLicense && licenseClass(toLicense) === "strong-copyleft") {
      add({
        ...base,
        key: key("license"),
        kind: "license",
        severity: "medium",
        title: `${pkg} is licensed ${toLicense}`,
        body: `This pull request adds ${pkg}, ${where}. ${toLicense} requires sharing source for code that uses it, including code served over a network. Check that these terms are acceptable.`,
      });
    }
  });
  return [...byKey.values()];
}

/** One level lower, for an advisory the code does not reach. */
export function lowerSeverity(s: Severity): Severity {
  return SEVERITY_ORDER[Math.max(0, SEVERITY_ORDER.indexOf(s) - 1)];
}
