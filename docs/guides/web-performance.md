# Web performance

How to keep `packages/web` responsive, and how to tell whether a change helped.

## Principles

1. **Composition over memoization.** Fix re-render problems by restructuring
   components, not by wrapping everything in `memo`. Move state down to where it
   is used; pass expensive children in as props.
2. **The query cache is the cache.** TanStack Query already caches, dedupes, and
   refetches. Do not add a second caching layer on top.
3. **Measure first.** Profile before optimizing. A guess about which component
   is slow is usually wrong, and the fix for the wrong component is pure cost.
4. **Know what React 19 does for you.** Automatic batching, `useTransition`, and
   `useDeferredValue` are built in. Learn them before reaching for a library.

The current state is worth knowing before you add anything: the tree holds 35
`useMemo`, 10 `useCallback`, and a single `memo`. That ratio is roughly right.
Memoization is a last resort, and the React documentation is explicit that
restructuring comes first.

## Restructure before you memoize

Three patterns solve most re-render problems with no memoization at all.

### Move state down

Push state as close to where it is used as possible:

```tsx
// Bad — typing in SearchInput re-renders ExpensiveList and Sidebar too.
function Page() {
  const [search, setSearch] = useState("");
  return (
    <>
      <SearchInput value={search} onChange={setSearch} />
      <ExpensiveList />
      <Sidebar />
    </>
  );
}

// Good — the state lives with the only component that reads it.
function Page() {
  return (
    <>
      <SearchSection />   {/* owns its own search state */}
      <ExpensiveList />
      <Sidebar />
    </>
  );
}
```

### Lift content up

When a wrapper re-renders on its own state, children passed to it as JSX do not
re-render — React keeps the element reference the parent created:

```tsx
// Bad — ScrollTracker builds the chart, so every scroll event re-renders it.
function ScrollTracker() {
  const [scrollY, setScrollY] = useState(0);
  return <div><ExpensiveChart data={data} /></div>;
}

// Good — the parent builds the chart; ScrollTracker only wraps it.
function Dashboard() {
  return (
    <ScrollTracker>
      <ExpensiveChart data={data} />
    </ScrollTracker>
  );
}

function ScrollTracker({ children }: { children: React.ReactNode }) {
  const [scrollY, setScrollY] = useState(0);
  return <div>{children}</div>;
}
```

### Split contexts by update frequency

Every consumer of a context re-renders when its value changes, whether or not it
reads the part that changed:

```tsx
// Bad — a theme toggle re-renders everything that reads the user.
const AppContext = createContext({ user: null, theme: "light" });

// Good — separate contexts, separate update frequencies.
const UserContext = createContext<User | null>(null);    // changes on login
const ThemeContext = createContext<"light" | "dark">("light");
```

For a context holding an object, memoize the value. A fresh object each render
re-renders every consumer even when nothing inside it changed.

## Memoization

### `memo`

Use it only when all three hold:

1. The profiler shows the component re-rendering with the same props.
2. Restructuring is not practical.
3. The component is genuinely expensive to render.

`memo` does not help when props are new references every render (the shallow
comparison always fails, so you pay for nothing), when the component reads
context (context bypasses `memo`), or when its own state is what changes.

### `useMemo`

Worth it for an expensive computation over a large collection, or to hold a
stable reference for a `memo` child or a dependency array.

```tsx
// Good — a real sort over a real list, stable deps.
const sorted = useMemo(
  () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
  [sessions],
);

// Bad — trivial. The memo costs more than the work.
const label = useMemo(() => `${first} ${last}`, [first, last]);
```

React does not guarantee it keeps the cached value. Never rely on `useMemo` for
correctness — only for speed.

### `useCallback`

Two valid uses: a function passed to a `memo` child, and a function in a
dependency array. It does not prevent the function from being created — it only
decides which reference to return. If the dependencies change every render, you
get nothing.

### The decision tree

```text
Re-render problem?
├── Can you move state down?                    → Do that. No memo needed.
├── Can you lift content up via children?        → Do that. No memo needed.
├── Is it context re-renders?                    → Split the context, or memoize its value.
├── Is a child re-rendering with the same props?
│   ├── Expensive child?                         → memo + stable props.
│   └── Cheap child?                             → Leave it. memo costs more.
└── Is a computation expensive?                  → useMemo with stable deps.
```

If you cannot name the re-render you are preventing, do not add the memo.

## Concurrent rendering

### `useTransition`

Marks an update as low priority so the UI stays interactive while React renders
in the background. Good for tab switches, filtering a large list, and navigation.
Not for controlled text inputs, which must update synchronously.

React 19 supports async functions inside `startTransition`, which React 18 did
not. If you are working from older guidance that says the callback must be
synchronous, that constraint no longer applies here.

`startTransition` defers rendering only. It does not throttle network requests —
use debouncing for that.

### `useDeferredValue`

The value-level counterpart: React keeps showing the previous value while
rendering the new one in the background. Use it when you receive a value you do
not control, such as a filter string from a parent.

Two constraints decide whether it does anything at all. The consuming component
must be wrapped in `memo`, or React re-renders it with the new value regardless.
And the deferred value must be a primitive or an already-memoized object —
`useDeferredValue({ sort })` builds a new object every render and defers nothing.

| | `useDeferredValue` | `useTransition` |
| --- | --- | --- |
| Use when | You receive a value | You call the setter |
| Pending signal | `value !== deferredValue` | `isPending` |
| Fits | Search and filter inputs | Tab switches, navigation |

Against debouncing: `useDeferredValue` adapts to the device and is
interruptible, but only defers rendering. Debouncing has a fixed delay and does
reduce network calls. They solve different problems.

## Code splitting

The router splits routes automatically. `vite.config.ts` sets
`autoCodeSplitting: true` on the TanStack Router plugin, so every file in
`src/routes/` becomes its own chunk without a manual `lazy()` anywhere.

That means the route-level work is already done. What is left is feature-level:
a heavy panel, editor, or dialog that is not visible on load can be split with
`lazy()` at its import and `<Suspense>` at its render site. Only do it when
bundle analysis shows the component is big enough to matter.

When adding a dependency, notice where it is imported. A large library used by
one route is lazy-loaded and fine. The same library imported from a shared
component lands in the entry chunk and is downloaded by everyone.

## The query cache as a performance tool

| Feature | Benefit |
| --- | --- |
| Shared cache | Components using one key share one entry — no duplicate requests |
| `staleTime` | Suppresses refetches while data is fresh |
| Background refetch | Data stays on screen while it updates — no spinner |
| `placeholderData` | Show the previous page while the next one loads |
| Prefetching | Warm the cache before the user arrives |

The router already prefetches on intent — `defaultPreload: "intent"` in
`main.tsx` warms a route when the user hovers its link.

Query deduplication is automatic. If three components mount and all call
`useSession(id)`, one request fires. Do not build your own deduplication.

## Anti-patterns

| Anti-pattern | Why it hurts | Fix |
| --- | --- | --- |
| Inline objects or arrays in JSX props | New reference each render; defeats `memo` | Hoist, or `useMemo` |
| Unstable context value | Every consumer re-renders | Memoize it; split the context |
| `useEffect` that sets state from props | An extra render cycle every time | Derive during render |
| `useEffect` + `fetch` for data | No cache, no dedupe, manual states | A hook in `src/api/` |
| `memo` on everything | Comparison cost for no benefit | Profile, then restructure |
| `useMemo` everywhere | Memory and noise, false confidence | Memoize what you can name |
| Object literal in `useDeferredValue` | New object each render defers nothing | Pass a primitive |
| `useTransition` on a text input | Inputs must update synchronously | `useDeferredValue` on the derived work |
| Effect chains that set state in sequence | Cascading renders | Compute during render |

## Strict Mode

In development React double-invokes renders, state initializers, `useMemo`
callbacks, and effect setup and cleanup. This is development-only and does not
affect production.

Double rendering is a diagnostic, not a problem to optimize away. If a component
breaks when rendered twice, it has an impure render or a missing effect cleanup.
Fix the impurity.

## Profiling

- **Profile production builds.** Development includes Strict Mode double
  renders and unoptimized code, so development timings are not real.
- **Throttle the CPU.** Chrome DevTools, Performance, 4x or 6x slowdown. What is
  instant on a development machine can stutter on a low-end laptop.
- **Measure before you change anything:**

```ts
console.time("filterSessions");
const filtered = sessions.filter(expensiveCheck);
console.timeEnd("filterSessions");
// Under 1ms: leave it. Over 16ms: that is a dropped frame — investigate.
```

| Tool | Shows |
| --- | --- |
| React DevTools Profiler | Render counts, timings, why a component rendered |
| TanStack Query DevTools | Cache state, refetch behavior |
| Chrome Performance panel | Long tasks, layout shifts, jank |

Valet has no browser telemetry in production today, so a regression that only
appears on a real user's device will not report itself. That makes the local
profiling habit the only defense — the numbers you take before and after a
change are the evidence.
