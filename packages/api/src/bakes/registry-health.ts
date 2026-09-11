/** Physical registry capacity is independent of logical bake sizes. */
export interface RegistryHealth {
  status: "healthy" | "full" | "unknown" | "unconfigured";
  capacityBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  reserveBytes: number | null;
}

export class RegistryCapacityError extends Error {
  readonly statusCode = 503;
  readonly code: "registry_full" | "registry_capacity_unknown";
  constructor(status: "full" | "unknown") {
    super(status === "full"
      ? "Sandbox image can't be built: registry full or below its free-space reserve. Free registry space or remove unused registry images. Run registry garbage collection after image removal."
      : "Sandbox image can't be built: registry capacity is unknown. Restore the registry health probe and retry.");
    this.name = "RegistryCapacityError";
    this.code = status === "full" ? "registry_full" : "registry_capacity_unknown";
  }
}

function positive(value: string | undefined, fallback: number, max = Infinity, allowZero = false): number {
  const n = Number(value);
  return Number.isFinite(n) && (n > 0 || allowZero && value !== undefined && value.trim() !== "" && n === 0) && n < max ? n : fallback;
}

export async function probeRegistry(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<RegistryHealth> {
  const empty = { capacityBytes: null, usedBytes: null, availableBytes: null, reserveBytes: null };
  const url = env.VALET_REGISTRY_HEALTH_URL;
  if (!url) return { status: "unconfigured", ...empty };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!res.ok) throw new Error("Registry probe request failed");
    const data = await res.json() as Record<string, unknown>;
    const { capacityBytes, availableBytes, usedBytes } = data;
    if (![capacityBytes, availableBytes, usedBytes].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      || (capacityBytes as number) <= 0 || (availableBytes as number) > (capacityBytes as number)
      || (usedBytes as number) > (capacityBytes as number)
      || (usedBytes as number) + (availableBytes as number) > (capacityBytes as number)) {
      throw new Error("Invalid registry capacity");
    }
    const capacity = capacityBytes as number;
    const available = availableBytes as number;
    const reserve = Math.max(
      positive(env.VALET_REGISTRY_MIN_FREE_GB, 5, Infinity, true) * 1e9,
      capacity * positive(env.VALET_REGISTRY_MIN_FREE_PERCENT, 10, 100) / 100,
    );
    return { status: available <= reserve ? "full" : "healthy", capacityBytes: capacity,
      availableBytes: available, usedBytes: usedBytes as number, reserveBytes: reserve };
  } catch {
    return { status: "unknown", ...empty };
  }
}

/** BuildKit and Docker push errors persist in bake error/log-tail fields. */
export function isPushFailure(error: string | null, logTail: string | null): boolean {
  return /failed to push|error pushing|push(?:ing)?[^\n]*(?:failed|denied|error)|(?:failed|error)[^\n]*push/i.test(`${error ?? ""}\n${logTail ?? ""}`);
}
