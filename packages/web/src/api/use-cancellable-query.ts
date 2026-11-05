import { useEffect } from "react";
import { hashKey, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

/** Disabling a mounted query stops polling, but does not cancel its current fetch. */
export function useCancellableQuery<T>(options: UseQueryOptions<T>) {
  const client = useQueryClient();
  const result = useQuery(options);
  const queryHash = hashKey(options.queryKey);
  useEffect(() => {
    if (options.enabled !== false) return;
    void client.cancelQueries({
      predicate: (query) => hashKey(query.queryKey) === queryHash && !query.isActive(),
    });
  }, [client, options.enabled, queryHash]);
  return result;
}
