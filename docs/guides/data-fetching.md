# Data fetching

Server state in `packages/web` is owned by TanStack Query v5. This guide covers
key factories, query hooks, invalidation, and mutations.

## Principles

- **Server state is not component state.** Read data from the query hook. The
  cache is the source of truth. Do not copy query results into `useState`.
- **Data access lives in `src/api/`.** Components call hooks; they do not call
  `fetch`.
- **One hook per use case.** Prefer a purpose-named hook (`useTeamMembers`) over
  a generic hook with option overrides.
- **Types come from the wire.** Import request and response types from
  `@valet/api/wire`. Never redeclare a server shape in the client.

Global defaults are set once, in `src/main.tsx`:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Sessions list, etc. — moderate freshness; WS will push live updates.
      staleTime: 5_000,
      retry: 1,
    },
  },
});
```

Override per query when a surface needs something different. Do not change the
defaults to fix one page.

## Query key factories

Every module in `src/api/` defines a key factory. Keys are always arrays, and
the factory is the only place a key is spelled.

```ts
// packages/web/src/api/queries.ts
export const qk = {
  /** The owner is a trailing element, so `["sessions"]` stays the prefix
   * that invalidates every workspace's list at once. */
  sessions: (owner?: OwnerFilter) =>
    ["sessions", ...(owner ? [owner.ownerType, owner.ownerId] : [])] as const,
  session: (id: string) => ["sessions", id] as const,
  threads: (id: string) => ["sessions", id, "threads"] as const,
  messages: (id: string, threadId?: string) =>
    threadId
      ? (["sessions", id, "messages", threadId] as const)
      : (["sessions", id, "messages"] as const),
};
```

**Order the segments broad to narrow.** `invalidateQueries` matches by prefix,
so a hierarchical key gives you invalidation at any depth for free. The comment
above `sessions` is load-bearing: putting the owner last keeps `["sessions"]` a
usable prefix. Put it first and you lose the ability to clear every list at once.

Never hand-write a key at the call site:

```ts
// Wrong — a second spelling of the same key. Invalidation will miss it.
useQuery({ queryKey: ["sessions", id, "messages"], queryFn: () => api.getMessages(id) });

// Right — one spelling, in one place.
useQuery({ queryKey: qk.messages(id), queryFn: () => api.getMessages(id) });
```

This rule is not hypothetical: about ten call sites in the tree still build keys
inline, outside `src/api/`. Each one is invisible to the invalidation that is
supposed to refresh it. When you touch one, move it into the factory.

## Query hooks

A read hook wraps `useQuery`, names itself for its purpose, and passes options
through:

```ts
// packages/web/src/api/settings.ts
export function useModels(opts?: UseQueryOptions<ListModelsResponse>) {
  return useQuery<ListModelsResponse>({
    queryKey: qkSettings.models(),
    queryFn: () => api.listModels(),
    // Org-admin-editable catalog — mutations invalidate this key on write,
    // but a short staleTime covers changes made from another tab.
    staleTime: 60_000,
    ...opts,
  });
}
```

### Conditional queries

When the parameter itself may be missing, use `skipToken`. The query keeps its
place in the cache and fires the moment the parameter arrives:

```ts
import { skipToken, useQuery } from "@tanstack/react-query";

export function useSession(id?: string) {
  return useQuery({
    queryKey: qk.session(id!),
    queryFn: id ? () => api.getSession(id) : skipToken,
  });
}
```

Use `enabled` when the decision to fetch is independent of the parameters — a
permission, or a parent that is not ready:

```ts
useQuery({ ...sessionOptions(id), enabled: canViewSessions });
```

Do not combine the two. `skipToken` means "I do not have the input yet".
`enabled` means "I have it but should not fetch yet". Together they produce a
query whose disabled state has two sources and no single answer.

### Consuming a hook

Guard on `isPending` and `isError` first. After the guard, TypeScript narrows
`data` to non-null:

```tsx
const { isPending, isError, error, data } = useSession(id);

if (isPending) return <Spinner />;
if (isError) return <ErrorNote message={error.message} />;

return <SessionDetail session={data} />;   // data is non-null here
```

| Status | True when | Use for |
| --- | --- | --- |
| `isLoading` | First fetch only, nothing cached yet | The initial skeleton |
| `isPending` | No data available yet | Type narrowing |
| `isFetching` | Any fetch, including background refetch | A subtle refresh indicator |

Reach for `isPending` in the guard. `isFetching` is the one to use when data is
on screen and you want to show that it is being refreshed without hiding it.

### No `onSuccess` on queries

Query-level `onSuccess` and `onError` do not exist in v5. Derive from state
instead, and prefer conditional rendering over an effect:

```tsx
// Wrong — v5 removed this. It silently never runs.
useQuery({ queryKey: qk.session(id), queryFn: fetchSession, onSuccess: goHome });

// Right — derive from the state you already have.
const { data, isSuccess } = useSession(id);
useEffect(() => {
  if (isSuccess && data.archived) navigate({ to: "/sessions" });
}, [isSuccess, data]);
```

## Invalidation

Invalidate at the narrowest scope that is still correct. The key hierarchy is
what gives you the choice:

```ts
qc.invalidateQueries({ queryKey: qk.sessions() });          // every session list
qc.invalidateQueries({ queryKey: qk.session(id) });         // one session, and everything under it
qc.invalidateQueries({ queryKey: qk.messages(id, tid) });   // one thread's messages
```

Because matching is by prefix, `qk.session(id)` also clears that session's
threads and messages. That is usually what you want after a write, and it is
worth knowing before you write three calls where one would do.

### Invalidating from live events

Valet pushes changes over a WebSocket. The house pattern is a small dedicated
hook that turns an event into an invalidation, rather than an invalidation
buried in a component:

```ts
// packages/web/src/hooks/use-invalidate-session-on-model-switch.ts
void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
void qc.invalidateQueries({ queryKey: qk.threads(sessionId) });
```

`use-invalidate-messages-on-queue-state.ts` and `use-workflow-patch-watch.ts`
follow the same shape. Keep new ones beside them, named for the event they
listen to and the thing they refresh. A hook named for its trigger is greppable
when a page goes stale; an `invalidateQueries` inside a `useEffect` in a
component is not.

## Mutations

A mutation invalidates the keys its write affects:

```ts
export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation<PatchMeResponse, Error, PatchMeRequest>({
    mutationFn: (body) => api.patchMe(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkSettings.me() });
    },
  });
}
```

List and detail are usually both affected. Invalidate both, or invalidate the
prefix that covers them:

```ts
onSuccess: (_data, vars) => {
  qc.invalidateQueries({ queryKey: qk.session(vars.id) });
  qc.invalidateQueries({ queryKey: qk.sessions() });
},
```

### Optimistic updates

Worth it when the mutation is small, conflict is unlikely, and the delay is
visible — renaming a thing, toggling a flag. The shape is cancel, snapshot,
write, roll back, settle:

```ts
useMutation({
  mutationFn: ({ id, name }: { id: string; name: string }) => api.rename(id, name),

  onMutate: async ({ id, name }) => {
    await qc.cancelQueries({ queryKey: qk.session(id) });
    const previous = qc.getQueryData(qk.session(id));
    qc.setQueryData(qk.session(id), (old: Session) => ({ ...old, name }));
    return { previous };
  },

  onError: (_err, { id }, context) => {
    if (context?.previous) qc.setQueryData(qk.session(id), context.previous);
  },

  onSettled: (_data, _err, { id }) => {
    qc.invalidateQueries({ queryKey: qk.session(id) });
  },
});
```

`cancelQueries` is not optional. Without it, a refetch already in flight can
land after your optimistic write and overwrite it with pre-write data.

Do not use optimistic updates for a multi-field write, or for anything whose
server result you cannot predict. Show a pending state instead.

## Anti-patterns

| Anti-pattern | Why it hurts | Fix |
| --- | --- | --- |
| An inline `queryKey` array | Invalidation misses the second spelling | Build it in the factory |
| Copying query data into `useState` | Two sources of truth; the copy goes stale | Read from the hook |
| `useEffect` + `fetch` | No cache, no dedupe, manual loading states | A hook in `src/api/` |
| `skipToken` and `enabled` together | Two sources for one disabled state | Pick the one that fits |
| Redeclaring a response type | Drifts silently on the next server change | Import from `@valet/api/wire` |
| Owner or filter first in a key | Destroys the invalidation prefix | Broad to narrow |
| Optimistic write without `cancelQueries` | An in-flight refetch clobbers it | Cancel, then write |
| Raising the global `staleTime` for one page | Changes every other page too | Override on that query |
