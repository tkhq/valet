import { ApiError } from "~/api/client";

/** True when the api answered 404: the thing is gone, and a retry cannot bring it back. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** A query `retry` that gives up at once on a 404 and retries anything else twice. */
export function retryUnlessNotFound(failureCount: number, error: unknown): boolean {
  return !isNotFound(error) && failureCount < 2;
}
