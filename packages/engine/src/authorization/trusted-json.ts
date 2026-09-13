import type { JsonValue } from "./types.js";

const MAX_DEPTH = 32;
const MAX_NODES = 4_096;

export class TrustedJsonError extends TypeError {
  constructor() { super("Trusted JSON input is malformed."); this.name = "TrustedJsonError"; }
}

/** Returns a frozen snapshot without reading through property accessors. */
export function trustedJsonClone<T>(value: T): T {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const clone = (item: unknown, depth: number): JsonValue => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new TrustedJsonError();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new TrustedJsonError();
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.values(descriptors).some((entry) => entry.get || entry.set)) throw new TrustedJsonError();
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new TrustedJsonError();
      const result = Object.keys(item).map((key) => clone(descriptors[key].value, depth + 1));
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new TrustedJsonError();
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) result[key] = clone(descriptors[key].value, depth + 1);
    return Object.freeze(result);
  };
  try {
    const result = clone(value, 1) as T;
    structuredClone(value); // The platform clone rejects proxies after the accessor check above.
    return result;
  } catch (error) {
    if (error instanceof TrustedJsonError) throw error;
    throw new TrustedJsonError();
  }
}
