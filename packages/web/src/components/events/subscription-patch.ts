/**
 * The pure diff behind the edit-subscription dialog: compare the form state
 * against the stored row and build the PATCH body of only the changed
 * fields. Kept apart from the dialog so the rules are testable without a
 * render — the same split the trigger dialog's edit branch encodes inline.
 */
import type {
  EventSubscriptionFilterWire,
  EventSubscriptionWire,
  PatchEventSubscriptionRequest,
} from "@valet/api/wire";
import { selectsSlackMention, storedAnyChannel } from "~/lib/slack-mention";
import { sameWireFilters } from "./filter-editor";

function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((k) => set.has(k));
}

/**
 * The PATCH body for a save, or null when nothing changed (the caller just
 * closes). Only changed fields are sent — an unchanged match must not ride
 * along, or the server re-runs its collision gate on a mere rename. Filters
 * compare through `sameWireFilters`, so jsonb key order and form-unreachable
 * corners cannot turn a rename into a filters rewrite.
 * Exceptions, mirroring the trigger dialog:
 *  - An "Any channel" toggle alone still sends the (unchanged) filters, so
 *    the server re-runs the mention gate against the new flag.
 *  - When the patch changes the match of a mention rule and "Any channel"
 *    is set, the `anyChannel` opt-out rides along.
 */
export function buildSubscriptionPatch(
  sub: EventSubscriptionWire,
  form: {
    name: string;
    eventKeys: string[];
    filters: EventSubscriptionFilterWire[];
    anyChannel: boolean;
  },
): PatchEventSubscriptionRequest | null {
  const body: PatchEventSubscriptionRequest = {};
  const name = form.name.trim();
  if (name !== sub.name) body.name = name;
  if (!sameKeySet(form.eventKeys, sub.eventKeys)) body.eventKeys = form.eventKeys;
  if (!sameWireFilters(form.filters, sub.filters)) body.filters = form.filters;

  const mention = selectsSlackMention(form.eventKeys);
  if (
    mention &&
    body.filters === undefined &&
    body.eventKeys === undefined &&
    form.anyChannel !== storedAnyChannel(sub.eventKeys, sub.filters)
  ) {
    body.filters = form.filters;
  }
  if ((body.filters !== undefined || body.eventKeys !== undefined) && mention && form.anyChannel) {
    body.anyChannel = true;
  }

  return Object.keys(body).length === 0 ? null : body;
}
