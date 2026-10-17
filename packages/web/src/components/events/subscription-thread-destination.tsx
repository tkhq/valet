import { useState } from "react";
import type { EventSubscriptionThreadWire } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { useEventSubscriptionThreads } from "~/api/events";
import { Button, Input, Label } from "~/components/primitives";
import { useDebouncedValue } from "~/hooks/use-debounced-value";

/** Null retains native channel routing for existing rules and Slack presets. */
export function SubscriptionThreadDestination({ owner, value, onChange, disabled = false }: {
  owner: OwnerFilter;
  value: EventSubscriptionThreadWire | null;
  onChange(value: EventSubscriptionThreadWire | null): void;
  disabled?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  return <div className="mt-4 space-y-2">
    <Label htmlFor="subscription-thread-mode">Run in</Label>
    <select id="subscription-thread-mode" className="w-full min-w-0 rounded border border-line bg-paper px-3 py-2 text-sm text-ink" disabled={disabled}
      value={picking ? "existing" : value?.mode ?? "automatic"}
      onChange={event => {
        const mode = event.target.value;
        setPicking(mode === "existing");
        if (mode === "existing") onChange({ mode: "existing", sessionId: "", threadId: "" });
        else onChange(mode === "new" ? { mode: "new" } : null);
      }}>
      <option value="automatic">Original conversation or event inbox</option>
      <option value="new">New thread for each event</option>
      <option value="existing">Existing thread</option>
    </select>
    {value?.mode === "existing" && value.threadId && <p className="break-all text-xs text-muted">Selected thread: {value.threadId}</p>}
    {(picking || value?.mode === "existing") && <ExistingThreadPicker key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} selected={value?.mode === "existing" ? value : undefined} disabled={disabled} onSelect={thread => { setPicking(false); onChange(thread); }} />}
    <p className="text-xs text-muted">New threads appear in the thread list. Existing threads keep their conversation history.</p>
    {owner.ownerType === "team" && <p className="text-xs text-muted">These destinations are shared with the whole team. Private Slack channels keep their original conversation routing.</p>}
  </div>;
}

function ExistingThreadPicker({ owner, selected, disabled, onSelect }: {
  owner: OwnerFilter; selected?: Extract<EventSubscriptionThreadWire, { mode: "existing" }>;
  disabled: boolean; onSelect(value: Extract<EventSubscriptionThreadWire, { mode: "existing" }>): void;
}) {
  const [search, setSearch] = useState("");
  const query = useEventSubscriptionThreads(owner, useDebouncedValue(search, 250));
  const threads = query.data?.pages.flatMap(page => page.threads) ?? [];
  return <div className="space-y-2">
    <Input aria-label="Search destination threads" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search threads" disabled={disabled} />
    {query.isPending && <p role="status" className="text-xs text-muted">Loading threads…</p>}
    {query.isError && <p role="alert" className="text-xs text-danger-500">Could not load threads. <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {!query.isPending && !query.isError && threads.length === 0 && <p className="text-xs text-muted">No eligible threads. Create a thread in this workspace, or choose a new thread for each event.</p>}
    {!query.isError && <div className="max-h-60 overflow-y-auto">
      {threads.map(thread => <button key={`${thread.sessionId}:${thread.id}`} type="button" disabled={disabled}
        aria-pressed={selected?.sessionId === thread.sessionId && selected.threadId === thread.id}
        className="block w-full rounded px-3 py-2 text-left text-sm text-ink hover:bg-ink-wash aria-pressed:bg-ink-wash"
        onClick={() => onSelect({ mode: "existing", sessionId: thread.sessionId, threadId: thread.id })}>{thread.title ?? "Untitled thread"}</button>)}
    </div>}
    {query.hasNextPage && <Button type="button" variant="ghost" size="sm" disabled={disabled || query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more threads"}</Button>}
  </div>;
}
