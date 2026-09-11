# Registry health implementation plan

**Goal:** Expose bake-cache pressure and reject new work before the registry disk fills.

**Architecture:** SourceService owns cache health and admission. A read-only registry sidecar reports filesystem capacity on request. The API keeps logical cache bytes separate from physical registry bytes. Configured but unavailable probes block new bakes. Deployments without a probe report unknown capacity.

**Tech stack:** TypeScript, Hono, Drizzle, OpenTelemetry, Helm, Python standard library.

1. Add registry probe tests for healthy, full, malformed, and unavailable responses. Implement a timed HTTP probe and configurable free-space reserve (10% or 5 GB, whichever is greater).
2. Add SourceService health tests for protected bakes, failed retention, unknown sizes, org isolation, and recent push failures. Add a guard before bake insertion and child side effects. Test the API authorization and error response.
3. Report health on startup and each minute, independent of bake completion. Emit cache-pressure and registry-pressure gauges and actionable structured error logs.
4. Add a read-only filesystem probe sidecar to the bundled registry. Wire its cluster-internal service URL into the API. Document external registry configuration and alert queries.
5. Run focused tests, typecheck, Helm rendering, and the required full make e2e scorecard. Review the diff and open a PR against dev-v2.

The disk reserve stops new admissions. It does not reserve space for in-flight uploads or external registry writers. Operators must size the reserve for concurrent builds. Protected bakes remain protected. Manifest deletion requires registry garbage collection to release disk blocks.

## Implementation decisions

The health endpoint is GET /api/org/sources/health and requires org-admin access. Push failures use persisted push-error text within a one-hour window.
Both retention paths share readCacheState protection. Tests cover live-session images, child creation without a repo, HTTP 503, and health authorization.
The sandbox reconcile spec documents the response, reserve policy, unknown telemetry, and operator alert rules.
