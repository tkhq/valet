/**
 * Selection-logic tests for Task 6 (kubernetes-deployment plan) —
 * `VALET_SANDBOX_BACKEND`'s docker/local/kubernetes/invalid branches.
 * No cluster required: the `kubernetes` case injects a fake-but-structurally
 * -valid `KubeConfig` (`loadFromOptions` against a dummy cluster) so
 * `KubernetesSandboxProvider` construction succeeds without ever making a
 * network call — `buildSandboxProvider` only *constructs* the provider
 * here, it never invokes any of its methods.
 */
import { describe, it, expect, vi } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import {
  KubernetesSandboxProvider,
  SANDBOX_CR_API_VERSION,
  buildSandboxManifest,
} from "@valet/sandbox-kubernetes";
import {
  buildSandboxProvider,
  parseSandboxBackend,
  resolveChildRetentionMs,
  resolveDefaultImage,
  resolveHibernatedRetentionMs,
  resolveIdleMinutes,
  resolveSandboxApiUrl,
  resolveKubeConfig,
  resolveSandboxEphemeralStorageLimit,
  resolveSandboxEphemeralStorageRequest,
  resolveSandboxWorkspaceStorage,
  resolveSandboxWorkspaceStorageMax,
} from "./sandbox-backend.js";

function fakeKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "test-cluster", server: "https://example.invalid", skipTLSVerify: true }],
    users: [{ name: "test-user" }],
    contexts: [{ name: "test-context", cluster: "test-cluster", user: "test-user" }],
    currentContext: "test-context",
  });
  return kc;
}

describe("parseSandboxBackend", () => {
  it("defaults to docker when unset", () => {
    expect(parseSandboxBackend(undefined)).toBe("docker");
    expect(parseSandboxBackend("")).toBe("docker");
  });

  it("accepts docker/local/kubernetes", () => {
    expect(parseSandboxBackend("docker")).toBe("docker");
    expect(parseSandboxBackend("local")).toBe("local");
    expect(parseSandboxBackend("kubernetes")).toBe("kubernetes");
  });

  it("throws a clear error on an invalid value", () => {
    expect(() => parseSandboxBackend("modal")).toThrow(
      /Invalid VALET_SANDBOX_BACKEND "modal": expected one of docker, local, kubernetes/,
    );
  });
});

describe("buildSandboxProvider", () => {
  it("builds a DockerSandboxProvider when VALET_SANDBOX_BACKEND is unset", () => {
    const provider = buildSandboxProvider({});
    expect(provider).toBeInstanceOf(DockerSandboxProvider);
    expect(provider.backend).toBe("docker");
  });

  it("builds a DockerSandboxProvider when VALET_SANDBOX_BACKEND=docker", () => {
    const provider = buildSandboxProvider({ VALET_SANDBOX_BACKEND: "docker" });
    expect(provider).toBeInstanceOf(DockerSandboxProvider);
  });

  it("builds a LocalSandboxProvider when VALET_SANDBOX_BACKEND=local", () => {
    const provider = buildSandboxProvider({ VALET_SANDBOX_BACKEND: "local" });
    expect(provider).toBeInstanceOf(LocalSandboxProvider);
    expect(provider.backend).toBe("local");
  });

  it("builds a KubernetesSandboxProvider from env, using an injected KubeConfig", () => {
    const provider = buildSandboxProvider(
      {
        VALET_SANDBOX_BACKEND: "kubernetes",
        VALET_SANDBOX_NAMESPACE: "custom-namespace",
        VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
      },
      { kubeConfig: fakeKubeConfig() },
    );
    expect(provider).toBeInstanceOf(KubernetesSandboxProvider);
    expect(provider.backend).toBe("kubernetes");
  });

  it("kubernetes path wires secretsApi: capabilities().credsMount is true", () => {
    // Regression: KubernetesSandboxProvider was constructed without secretsApi,
    // so capabilities().credsMount was always false and creds Secrets were never
    // created in production.
    const provider = buildSandboxProvider(
      {
        VALET_SANDBOX_BACKEND: "kubernetes",
        VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
      },
      { kubeConfig: fakeKubeConfig() },
    );
    expect(provider.capabilities().credsMount).toBe(true);
  });

  it("defaults the kubernetes namespace when VALET_SANDBOX_NAMESPACE is unset", () => {
    // Construction succeeding (no throw) is the assertion here — the
    // namespace/image aren't otherwise observable from outside the
    // provider without a live cluster round-trip, so this just proves the
    // default-namespace path doesn't require VALET_SANDBOX_NAMESPACE.
    expect(() =>
      buildSandboxProvider(
        { VALET_SANDBOX_BACKEND: "kubernetes", VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest" },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).not.toThrow();
  });

  it("warns (does not throw) when VALET_SANDBOX_BACKEND=kubernetes and VALET_SANDBOX_IMAGE is unset — seeded base sources are now the primary path", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() =>
        buildSandboxProvider({ VALET_SANDBOX_BACKEND: "kubernetes" }, { kubeConfig: fakeKubeConfig() }),
      ).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("VALET_SANDBOX_IMAGE"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws a clear error for an unrecognized backend", () => {
    expect(() => buildSandboxProvider({ VALET_SANDBOX_BACKEND: "ec2" })).toThrow(
      /Invalid VALET_SANDBOX_BACKEND "ec2"/,
    );
  });

  it("throws at boot when the workspace default exceeds the cap (TKAI-403: contradictory deploy config)", () => {
    expect(() =>
      buildSandboxProvider(
        {
          VALET_SANDBOX_BACKEND: "kubernetes",
          VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
          VALET_SANDBOX_WORKSPACE_STORAGE: "8Gi",
          VALET_SANDBOX_WORKSPACE_MAX: "4Gi",
        },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(/VALET_SANDBOX_WORKSPACE_STORAGE \(effective "8Gi"\) exceeds VALET_SANDBOX_WORKSPACE_MAX \(effective "4Gi"\)/);
  });
});

describe("storage quantity env validation (TKAI-403)", () => {
  it("an unparseable quantity throws at boot naming the env var — a typo must not 422 every CR at admission", () => {
    expect(() => resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "8GB" })).toThrow(
      /VALET_SANDBOX_WORKSPACE_STORAGE="8GB" is not a positive Kubernetes quantity/,
    );
    expect(() => resolveSandboxWorkspaceStorageMax({ VALET_SANDBOX_WORKSPACE_MAX: "twenty" })).toThrow(
      /VALET_SANDBOX_WORKSPACE_MAX="twenty"/,
    );
    expect(() =>
      resolveSandboxEphemeralStorageRequest({ VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: "-2Gi" }),
    ).toThrow(/VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST/);
    expect(() =>
      resolveSandboxEphemeralStorageLimit({ VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: "8 gigs" }),
    ).toThrow(/VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT/);
  });

  it('"0" still disables, unset still defaults, and a padded value is trimmed', () => {
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "0" })).toBeUndefined();
    expect(resolveSandboxWorkspaceStorage({})).toBe("1Gi");
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: " 8Gi " })).toBe("8Gi");
  });

  it("every zero spelling disables — padded, suffixed", () => {
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: " 0 " })).toBeUndefined();
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "0Gi" })).toBeUndefined();
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "   " })).toBe("1Gi");
  });

  it("the default-over-cap boot check compares EFFECTIVE values — a \"0\" cap does not bypass it", () => {
    expect(() =>
      buildSandboxProvider(
        {
          VALET_SANDBOX_BACKEND: "kubernetes",
          VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
          VALET_SANDBOX_WORKSPACE_STORAGE: "50Gi",
          VALET_SANDBOX_WORKSPACE_MAX: "0",
        },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(/effective "50Gi".*effective "20Gi"/);
  });

  it("throws at boot when an explicit ephemeral request exceeds the default limit", () => {
    expect(() =>
      buildSandboxProvider(
        {
          VALET_SANDBOX_BACKEND: "kubernetes",
          VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
          VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: "10Gi",
        },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(
      /VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST \(effective "10Gi"\) exceeds VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT \(effective "8Gi"\).*Lower the request or raise the limit/,
    );
  });

  it("throws at boot when the default ephemeral request exceeds an explicit limit", () => {
    expect(() =>
      buildSandboxProvider(
        {
          VALET_SANDBOX_BACKEND: "kubernetes",
          VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
          VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: "1Gi",
        },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(/effective "2Gi".*effective "1Gi"/);
  });

  it.each([
    { request: "0", limit: "1Gi" },
    { request: "10Gi", limit: "0" },
  ])("allows a disabled ephemeral side: request=$request limit=$limit", ({ request, limit }) => {
    expect(() =>
      buildSandboxProvider(
        {
          VALET_SANDBOX_BACKEND: "kubernetes",
          VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
          VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: request,
          VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: limit,
        },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).not.toThrow();
  });
});

describe("resolveDefaultImage", () => {
  it("returns undefined when VALET_SANDBOX_IMAGE is unset (docker default stays node:20-bookworm)", () => {
    expect(resolveDefaultImage({})).toBeUndefined();
  });

  it("pins VALET_SANDBOX_IMAGE through to the resolved default image, for the docker backend too", () => {
    expect(resolveDefaultImage({ VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:full" })).toBe(
      "ghcr.io/example/sandbox:full",
    );
  });
});

describe("resolveIdleMinutes", () => {
  it("defaults to 30 when VALET_SANDBOX_IDLE_MINUTES is unset", () => {
    expect(resolveIdleMinutes({})).toBe(30);
  });

  it("parses a positive VALET_SANDBOX_IDLE_MINUTES value", () => {
    expect(resolveIdleMinutes({ VALET_SANDBOX_IDLE_MINUTES: "5" })).toBe(5);
  });

  it("treats an explicit 0 as disabled", () => {
    expect(resolveIdleMinutes({ VALET_SANDBOX_IDLE_MINUTES: "0" })).toBe(0);
  });

  it("treats a negative value as disabled", () => {
    expect(resolveIdleMinutes({ VALET_SANDBOX_IDLE_MINUTES: "-5" })).toBe(0);
  });

  it("treats a non-numeric value as disabled", () => {
    expect(resolveIdleMinutes({ VALET_SANDBOX_IDLE_MINUTES: "bogus" })).toBe(0);
  });
});

describe("resolveChildRetentionMs", () => {
  it("defaults to 24 hours when VALET_CHILD_SANDBOX_RETENTION_HOURS is unset", () => {
    expect(resolveChildRetentionMs({})).toBe(24 * 3_600_000);
  });

  it("parses a positive hours value", () => {
    expect(resolveChildRetentionMs({ VALET_CHILD_SANDBOX_RETENTION_HOURS: "6" })).toBe(6 * 3_600_000);
  });

  it("treats an explicit 0 as disabled (eager destroy on settle)", () => {
    expect(resolveChildRetentionMs({ VALET_CHILD_SANDBOX_RETENTION_HOURS: "0" })).toBe(0);
  });

  it("treats a negative value as disabled", () => {
    expect(resolveChildRetentionMs({ VALET_CHILD_SANDBOX_RETENTION_HOURS: "-5" })).toBe(0);
  });

  it("treats a non-numeric value as disabled", () => {
    expect(resolveChildRetentionMs({ VALET_CHILD_SANDBOX_RETENTION_HOURS: "bogus" })).toBe(0);
  });

  it("keeps children on a SHORTER window than every other session class", () => {
    // The class split is the point: children are the high-churn, use-once
    // class (hundreds a day, each holding a workspace PVC), while
    // orchestrators and assistants are provisioned rarely and revisited
    // for weeks. A change that collapses the two should fail here.
    expect(resolveChildRetentionMs({})).toBeLessThan(resolveHibernatedRetentionMs({}));
  });
});

describe("resolveHibernatedRetentionMs", () => {
  it("defaults to 72 hours when VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES is unset", () => {
    expect(resolveHibernatedRetentionMs({})).toBe(72 * 60 * 60_000);
  });

  it("parses a positive minutes value", () => {
    expect(resolveHibernatedRetentionMs({ VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES: "15" })).toBe(15 * 60_000);
  });

  it("treats an explicit 0 as disabled", () => {
    expect(resolveHibernatedRetentionMs({ VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES: "0" })).toBe(0);
  });

  it("treats a negative value as disabled", () => {
    expect(resolveHibernatedRetentionMs({ VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES: "-5" })).toBe(0);
  });

  it("treats a non-numeric value as disabled", () => {
    expect(resolveHibernatedRetentionMs({ VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES: "bogus" })).toBe(0);
  });
});

describe("resolveSandboxEphemeralStorageRequest / Limit (TKAI-349)", () => {
  it("defaults to 2Gi request / 8Gi limit when unset", () => {
    expect(resolveSandboxEphemeralStorageRequest({})).toBe("2Gi");
    expect(resolveSandboxEphemeralStorageLimit({})).toBe("8Gi");
  });

  it("passes explicit quantity strings through verbatim", () => {
    expect(
      resolveSandboxEphemeralStorageRequest({ VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: "500Mi" }),
    ).toBe("500Mi");
    expect(
      resolveSandboxEphemeralStorageLimit({ VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: "16Gi" }),
    ).toBe("16Gi");
  });

  it('treats "0" as disabled (manifest omits the field)', () => {
    expect(
      resolveSandboxEphemeralStorageRequest({ VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: "0" }),
    ).toBeUndefined();
    expect(
      resolveSandboxEphemeralStorageLimit({ VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: "0" }),
    ).toBeUndefined();
  });

  it("treats an empty string as unset (default applies)", () => {
    expect(
      resolveSandboxEphemeralStorageRequest({ VALET_SANDBOX_EPHEMERAL_STORAGE_REQUEST: "" }),
    ).toBe("2Gi");
    expect(resolveSandboxEphemeralStorageLimit({ VALET_SANDBOX_EPHEMERAL_STORAGE_LIMIT: "" })).toBe(
      "8Gi",
    );
  });
});

describe("resolveSandboxWorkspaceStorage", () => {
  it("defaults to 1Gi when VALET_SANDBOX_WORKSPACE_STORAGE is unset", () => {
    expect(resolveSandboxWorkspaceStorage({})).toBe("1Gi");
  });

  it("matches the manifest builder's own fallback, so both paths provision the same volume", () => {
    // Two defaults that drift produce a different workspace depending on
    // whether the env knob was read — the exact class of bug the unwired
    // `defaultStorage` field caused before this.
    const manifest = buildSandboxManifest(
      { namespace: "ns", defaultImage: "img", apiVersion: SANDBOX_CR_API_VERSION },
      "sess-1",
      {},
    );
    expect(manifest.spec.volumeClaimTemplates[0]?.spec.resources.requests.storage).toBe(
      resolveSandboxWorkspaceStorage({}),
    );
  });

  it("passes an explicit quantity through verbatim", () => {
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "20Gi" })).toBe("20Gi");
  });

  it('treats "0" as unset so the manifest default applies, never a zero-sized claim', () => {
    expect(resolveSandboxWorkspaceStorage({ VALET_SANDBOX_WORKSPACE_STORAGE: "0" })).toBeUndefined();
  });
});

describe("resolveSandboxWorkspaceStorageMax", () => {
  it("defaults to 20Gi when VALET_SANDBOX_WORKSPACE_MAX is unset", () => {
    expect(resolveSandboxWorkspaceStorageMax({})).toBe("20Gi");
    expect(resolveSandboxWorkspaceStorageMax({ VALET_SANDBOX_WORKSPACE_MAX: "" })).toBe("20Gi");
  });

  it("passes an explicit quantity through verbatim", () => {
    expect(resolveSandboxWorkspaceStorageMax({ VALET_SANDBOX_WORKSPACE_MAX: "50Gi" })).toBe("50Gi");
  });

  it('treats "0" as unset so the provider\'s own default cap applies', () => {
    expect(resolveSandboxWorkspaceStorageMax({ VALET_SANDBOX_WORKSPACE_MAX: "0" })).toBeUndefined();
  });
});

describe("resolveKubeConfig", () => {
  it("takes the in-cluster branch when KUBERNETES_SERVICE_HOST is set", () => {
    // `loadFromCluster()` doesn't validate the mounted service-account
    // files exist (that's deferred to actual request time) — it just
    // synthesizes a cluster entry named "inCluster" pointing at
    // `/var/run/secrets/kubernetes.io/serviceaccount/...` and the
    // `KUBERNETES_SERVICE_HOST`/`_PORT` env pair. Asserting that shape is
    // present is the proof `resolveKubeConfig` took the in-cluster branch
    // rather than `loadFromDefault()` (whose cluster names come from the
    // ambient kubeconfig file, never "inCluster").
    const kc = resolveKubeConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443" });
    expect(kc.getClusters().map((c) => c.name)).toContain("inCluster");
  });

  it("pins VALET_KUBE_CONTEXT when out-of-cluster and the context exists", () => {
    // loadFromDefault() reads the real ambient kubeconfig on this machine;
    // skip if none is configured (CI/sandbox without a kubeconfig file).
    const probe = new k8s.KubeConfig();
    try {
      probe.loadFromDefault();
    } catch {
      return;
    }
    const contexts = probe.getContexts();
    if (contexts.length === 0) return;
    const [{ name }] = contexts;
    const kc = resolveKubeConfig({ VALET_KUBE_CONTEXT: name });
    expect(kc.getCurrentContext()).toBe(name);
  });

  it("throws when VALET_KUBE_CONTEXT names a context that doesn't exist", () => {
    const probe = new k8s.KubeConfig();
    try {
      probe.loadFromDefault();
    } catch {
      return;
    }
    expect(() => resolveKubeConfig({ VALET_KUBE_CONTEXT: "definitely-not-a-real-context-xyz" })).toThrow(
      /VALET_KUBE_CONTEXT="definitely-not-a-real-context-xyz" is not a configured kubectl context/,
    );
  });

  it("REFUSES the ambient current-context out-of-cluster (decision 2): throws when VALET_KUBE_CONTEXT is unset", () => {
    // The whole point: a dev machine's ambient current-context is routinely
    // a production cluster. Out-of-cluster + backend=kubernetes with no
    // pinned context must throw, never silently target prod. No env vars →
    // not in-cluster (KUBERNETES_SERVICE_HOST absent), no pinned context.
    expect(() => resolveKubeConfig({})).toThrow(/VALET_KUBE_CONTEXT is required/);
  });
});

/**
 * `VALET_API_URL` must be reachable FROM a sandbox. On the docker backend a
 * loopback host names the sandbox itself, so every in-sandbox client
 * (`git-credential-valet`, `valet-gh`, `valet-secrets`) fails to connect.
 */
describe("resolveSandboxApiUrl", () => {
  const docker = { VALET_SANDBOX_BACKEND: "docker" } as NodeJS.ProcessEnv;

  it("rewrites every loopback spelling to host.docker.internal on docker", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      expect(resolveSandboxApiUrl(docker, `http://${host}:8788`)).toBe("http://host.docker.internal:8788");
    }
    expect(resolveSandboxApiUrl(docker, "http://[::1]:8788")).toBe("http://host.docker.internal:8788");
  });

  it("treats an unset backend as docker (the documented default)", () => {
    expect(resolveSandboxApiUrl({}, "http://localhost:8788")).toBe("http://host.docker.internal:8788");
  });

  it("keeps the scheme, port, and path", () => {
    expect(resolveSandboxApiUrl(docker, "https://localhost:9443/base")).toBe(
      "https://host.docker.internal:9443/base",
    );
  });

  it("does not append a trailing slash to a bare origin", () => {
    expect(resolveSandboxApiUrl(docker, "http://localhost:8788")).not.toMatch(/\/$/);
  });

  it("leaves a routable host alone — the operator meant it", () => {
    expect(resolveSandboxApiUrl(docker, "https://valet.example.com")).toBe("https://valet.example.com");
  });

  it("leaves other backends alone", () => {
    for (const backend of ["kubernetes", "local"]) {
      expect(resolveSandboxApiUrl({ VALET_SANDBOX_BACKEND: backend }, "http://localhost:8788")).toBe(
        "http://localhost:8788",
      );
    }
  });

  it("passes through unset, empty, and unparseable values untouched", () => {
    expect(resolveSandboxApiUrl(docker, undefined)).toBeUndefined();
    expect(resolveSandboxApiUrl(docker, "")).toBe("");
    expect(resolveSandboxApiUrl(docker, "not a url")).toBe("not a url");
  });
});
