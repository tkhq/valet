import {
  QueryClient,
  skipToken,
  type DefaultError,
  type DefaultedQueryObserverOptions,
  type MutationOptions,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";

/** A component read a query key that the gallery did not seed. */
export class MissingFixtureError extends Error {
  constructor(readonly queryKey: QueryKey) {
    super(`The UI stress gallery has no fixture for ${JSON.stringify(queryKey)}. Seed it in src/dev/ui-stress/seed.ts.`);
    this.name = "MissingFixtureError";
  }
}

export const MUTATIONS_DISABLED = "The UI stress gallery does not send changes. Use a real page to test this action.";

/** Options that stop every refetch trigger. The hooks set some of these
 * themselves (a 5 s `refetchInterval` on the bell's lists, `staleTime: 0`
 * on the account read), and hook options win over `setQueryDefaults`, so the
 * client applies them after the hook's own options. */
const FROZEN = {
  staleTime: Infinity,
  // A seeded key that no component reads yet (the second decision page)
  // must survive until one does.
  gcTime: Infinity,
  refetchInterval: false,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

function isInfiniteData(value: unknown): value is { pages: unknown[]; pageParams: unknown[] } {
  return typeof value === "object" && value !== null
    && "pages" in value && Array.isArray(value.pages)
    && "pageParams" in value && Array.isArray(value.pageParams);
}

/** Builds a fixture for a key that a person's input decides (a search, a
 * filter, a next page). `page` is set for an infinite query. Returns
 * undefined for a key it does not know. */
export type FixtureResolver = (queryKey: QueryKey, page: { param: unknown } | undefined) => unknown;

/**
 * A QueryClient that never reaches the network. Every query function reads
 * the value already in the cache for its own key, then asks the resolver, so
 * an explicit `refetch()` (the bell refetches when it opens) returns the
 * fixture again. A key with neither fails with `MissingFixtureError`. Every
 * mutation fails with `MUTATIONS_DISABLED`, so an Approve click on a fixture
 * never reaches the dev api with a made-up id.
 */
export class FrozenQueryClient extends QueryClient {
  readonly #resolve: FixtureResolver;

  constructor(resolve: FixtureResolver = () => undefined) {
    super();
    this.#resolve = resolve;
  }

  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey, TPageParam>
      | DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  ): DefaultedQueryObserverOptions<TQueryFnData, TError, TData, TQueryData, TQueryKey> {
    const defaulted = super.defaultQueryOptions(options);
    if (defaulted.queryFn === skipToken) return { ...defaulted, ...FROZEN };
    return {
      ...defaulted,
      ...FROZEN,
      queryFn: async (context) => {
        const cached: unknown = this.getQueryData(context.queryKey);
        // An infinite query fetches one page at a time by its page param.
        const page = "pageParam" in context ? { param: context.pageParam } : undefined;
        const data = (page ? pageOf(cached, page.param) : cached) ?? this.#resolve(context.queryKey, page);
        if (data === undefined) throw new MissingFixtureError(context.queryKey);
        // The seed or the resolver built this value for this exact key, as
        // the response type of the hook that owns the key.
        return data as TQueryFnData;
      },
    };
  }

  override defaultMutationOptions<T extends MutationOptions<unknown, unknown, unknown, unknown>>(options?: T): T {
    const defaulted = super.defaultMutationOptions(options);
    return { ...defaulted, retry: false, mutationFn: () => Promise.reject(new Error(MUTATIONS_DISABLED)) };
  }
}

function pageOf(cached: unknown, pageParam: unknown): unknown {
  if (!isInfiniteData(cached)) return undefined;
  const wanted = JSON.stringify(pageParam);
  const index = cached.pageParams.findIndex((param) => JSON.stringify(param) === wanted);
  return index === -1 ? undefined : cached.pages[index];
}
