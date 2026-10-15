/** A card owns its browser state. Normal browser tabs keep their existing keys. */
export function cardId(name = typeof window === "undefined" ? "" : window.name, embedded = typeof window !== "undefined" && window.parent !== window): string | undefined {
  return embedded && /^valet-card:[a-zA-Z0-9-]+$/.test(name) ? name.slice(11) : undefined;
}

export function cardStorageKey(key: string, id = cardId()): string {
  return id ? `valet:card:${id}:${key}` : key;
}
