import {
  QueryClient,
  type DefaultError,
  type DefaultedQueryObserverOptions,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import { backoffDelay, installConnection, retryThroughOutage } from "./connection";

/**
 * The app's query client. Every query rides through an api restart
 * (`connection.ts`): panels keep their data while the api is down, and
 * refetch when it returns, whatever `retry` rule the query sets.
 */
export class AppQueryClient extends QueryClient {
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
    // Options defaulted before already carry the wrapped rule.
    if (defaulted === options) return defaulted;
    // A paused query with no data is neither loading nor failed, so a panel
    // would show its empty state during the outage. A query without data
    // keeps retrying instead, and stays loading until the api answers.
    const hasData = this.getQueryCache().get(defaulted.queryHash)?.state.data !== undefined;
    const networkMode = defaulted.networkMode ?? (hasData ? undefined : "always");
    return { ...defaulted, retry: retryThroughOutage(defaulted.retry), ...(networkMode ? { networkMode } : {}) };
  }
}

/**
 * A change never waits offline: it fails at once, and the person sees why.
 * A change parked in memory is lost on reload. Tests that build their own
 * client take this object, so they run the app's rule.
 */
export const APP_MUTATION_DEFAULTS = { networkMode: "always" } as const;

export function createQueryClient(): AppQueryClient {
  const client = new AppQueryClient({
    defaultOptions: {
      queries: {
        // Sessions list, etc. — moderate freshness; WS will push live updates.
        staleTime: 5_000,
        retry: 1,
        // TanStack counts failures from 0. While the api is down, a retry
        // that comes due pauses until the api answers again.
        retryDelay: (failureCount) => backoffDelay(failureCount + 1),
      },
      mutations: APP_MUTATION_DEFAULTS,
    },
  });
  installConnection(client);
  return client;
}
