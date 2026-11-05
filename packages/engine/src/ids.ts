let nextId = 1;

/**
 * A new id: `<prefix>-<time>-<sequence><random>`. Time and sequence keep ids
 * from one process in order; the random part keeps two processes that start
 * in the same millisecond from minting the same id. Thread ids are looked up
 * across sessions, so they must be unique across every API process.
 */
export function uid(prefix: string): string {
  const random = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}${random}`;
}
