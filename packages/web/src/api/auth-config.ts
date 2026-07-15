/**
 * `GET /api/auth-config` — unauthenticated; drives `/login`/`/signup`
 * control rendering and the client-side 401 route guard (see
 * `api/client.ts`'s `request`). `staleTime: Infinity` — this doesn't
 * change without a server restart.
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { AuthConfigResponse } from "@valet/api/wire";
import { api } from "./client";

export const qkAuthConfig = ["auth-config"] as const;

export function useAuthConfig(opts?: UseQueryOptions<AuthConfigResponse>) {
  return useQuery<AuthConfigResponse>({
    queryKey: qkAuthConfig,
    queryFn: () => api.getAuthConfig(),
    staleTime: Infinity,
    ...opts,
  });
}
