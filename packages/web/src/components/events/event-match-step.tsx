/**
 * The split the editor's event picker reads: a service's common events,
 * in their set order, and the rest behind `More events`.
 */
import { COMMON_EVENTS, type SentenceService } from "~/components/presence/sentences";
import type { CatalogService } from "./subscription-match";

function knownService(service: string): SentenceService | undefined {
  return service === "slack" || service === "github" || service === "linear" ? service : undefined;
}

type Entry = CatalogService["entries"][number];

/** A service's events split into the common ones, in their set order, and the rest. */
export function splitCommon(service: CatalogService): { common: Entry[]; more: Entry[] } {
  const known = knownService(service.service);
  const order = known !== undefined ? COMMON_EVENTS[known] : [];
  const common = order.flatMap((key) => service.entries.filter((e) => e.key === key));
  if (common.length === 0) return { common: service.entries, more: [] };
  return { common, more: service.entries.filter((e) => !order.includes(e.key)) };
}
