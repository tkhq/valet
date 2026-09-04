/**
 * Storage-quantity math shared by the manifest builder (create-time
 * workspace sizing, TKAI-385) and the workspace-PVC growth path
 * (`workspace-pvc.ts`). Lives in its own module so `manifest.ts` can import
 * it without a cycle (`workspace-pvc.ts` imports `WORKSPACE_VOLUME_NAME`
 * from `manifest.ts`).
 */

/** Fallback cap for workspace sizing and growth when
 * `K8sProviderConfig.workspaceStorageMax` is unset. */
export const DEFAULT_WORKSPACE_STORAGE_MAX = "20Gi";

const BINARY_SUFFIXES: Record<string, bigint> = {
  Ki: 2n ** 10n,
  Mi: 2n ** 20n,
  Gi: 2n ** 30n,
  Ti: 2n ** 40n,
  Pi: 2n ** 50n,
  Ei: 2n ** 60n,
};

const DECIMAL_SUFFIX_POWERS: Record<string, number> = {
  n: -9,
  u: -6,
  m: -3,
  "": 0,
  k: 3,
  K: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
};

const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_QUANTITY_LENGTH = 256;

/** Rounds `digits / 10^decimalPlaces` up without a floating-point conversion. */
function roundDecimalMagnitude(digits: string, decimalPlaces: number): bigint | null {
  const normalized = digits.replace(/^0+/, "");
  if (normalized.length === 0) return 0n;
  if (!Number.isSafeInteger(decimalPlaces)) return null;

  if (decimalPlaces <= 0) {
    const outputDigits = normalized.length - decimalPlaces;
    if (!Number.isSafeInteger(outputDigits) || outputDigits > 16) return null;
    const magnitude = BigInt(normalized) * 10n ** BigInt(-decimalPlaces);
    return magnitude <= MAX_SAFE_BYTES ? magnitude : null;
  }

  const wholeLength = normalized.length - decimalPlaces;
  if (wholeLength <= 0) return 1n;
  if (wholeLength > 16) return null;
  const whole = BigInt(normalized.slice(0, wholeLength));
  const fraction = normalized.slice(wholeLength);
  const magnitude = whole + (/[1-9]/.test(fraction) ? 1n : 0n);
  return magnitude <= MAX_SAFE_BYTES ? magnitude : null;
}

/**
 * Parses a Kubernetes storage quantity ("1Gi", "500m", "2G", "1e6") to
 * bytes, or null when unparseable. The parser accepts DecimalSI, BinarySI,
 * and decimal-exponent suffixes from resource.Quantity. It rounds fractional
 * bytes away from zero so a positive value cannot become the disable value.
 */
export function parseStorageQuantity(quantity: string): number | null {
  const trimmed = quantity.trim();
  if (trimmed.length > MAX_QUANTITY_LENGTH) return null;
  const match = /^([+-]?)([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|[numkKMGTP]|E|[eE][+-]?[0-9]+)?$/.exec(
    trimmed,
  );
  if (!match) return null;
  const sign = match[1];
  const decimal = match[2];
  const decimalPoint = decimal.indexOf(".");
  const decimalPlaces = decimalPoint === -1 ? 0 : decimal.length - decimalPoint - 1;
  const digits = decimal.replace(".", "");
  const suffix = match[3] ?? "";
  const exponent = /^[eE]([+-]?[0-9]+)$/.exec(suffix);
  const binaryUnit = BINARY_SUFFIXES[suffix];
  let magnitude: bigint | null;
  if (binaryUnit !== undefined) {
    const numerator = (BigInt(digits) * binaryUnit).toString();
    magnitude = roundDecimalMagnitude(numerator, decimalPlaces);
  } else {
    const suffixPower = exponent ? Number(exponent[1]) : DECIMAL_SUFFIX_POWERS[suffix];
    if (suffixPower === undefined || !Number.isSafeInteger(suffixPower)) return null;
    magnitude = roundDecimalMagnitude(digits, decimalPlaces - suffixPower);
  }
  if (magnitude === null) return null;
  if (magnitude === 0n) return 0;
  return Number(sign === "-" ? -magnitude : magnitude);
}

/** Formats bytes as the largest binary suffix that divides evenly (else
 * plain bytes) — the doubles of any whole-Mi quantity stay whole. */
export function formatStorageQuantity(bytes: number): string {
  for (const [suffix, unit] of [
    ["Gi", 2 ** 30],
    ["Mi", 2 ** 20],
    ["Ki", 2 ** 10],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}`;
}

/**
 * Clamps a requested storage quantity to a cap: the request (trimmed) when it
 * fits, the cap (trimmed) when it exceeds it (`clamped: true`), or null when
 * either quantity is unparseable — the caller falls back to its default
 * rather than provisioning an unknown size (a typo'd cap must never grant an
 * unbounded request).
 *
 * Trimmed, never verbatim: `parseStorageQuantity` trims before matching, so a
 * whitespace-padded value (`"8Gi "` survives YAML quoting) parses here — but
 * emitted verbatim it fails the CRD's quantity pattern and the CR is rejected
 * at admission, which kills the sandbox outright instead of falling back.
 */
export function clampStorageRequest(
  requested: string,
  max: string,
): { storage: string; clamped: boolean } | null {
  const requestedBytes = parseStorageQuantity(requested);
  if (requestedBytes === null || requestedBytes <= 0) return null;
  const maxBytes = parseStorageQuantity(max);
  if (maxBytes === null || maxBytes <= 0) return null;
  if (requestedBytes > maxBytes) return { storage: max.trim(), clamped: true };
  return { storage: requested.trim(), clamped: false };
}
