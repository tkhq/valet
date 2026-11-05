# Durable sandbox tokens

TKAI-498 makes sandbox API credentials last until teardown. API restarts and
cache eviction must not require a running sandbox to receive a new bearer.

## Storage and adoption

`getOrCreateSandboxToken` derives `st_` plus 48 hexadecimal characters with
HMAC-SHA256. Its input includes a versioned domain, a random row ID, and the
session, user, and organization IDs. The key is the stable instance encryption
key. The database stores only the bearer hash.

A build reads unrevoked, unexpired rows for the full principal. It recovers each
candidate and compares its hash. It adopts the oldest matching row. If no row
matches, it inserts a new credential without revoking previous credentials.
Concurrent first builds can insert two valid credentials. Teardown revokes both.

Lifetime rows use `9999-12-31T23:59:59Z` as an expiry sentinel. This retains the
existing schema and supports older API verifiers during a rolling update.
No migration or plaintext credential column is required.

The host passes the bearer through both environment variables and credential
files. The hourly rotation sweep is removed. Neither credential-mount support
nor Secret propagation controls bearer validity. Sandbox JWT behavior is unchanged.

## Upgrade and teardown

Before serving, the API extends still-valid legacy rows to the lifetime sentinel.
Verification also extends a valid legacy row issued by an older replica after
boot. These writes never clear revocation or revive an expired credential.

Drain older replicas during rollout. A legacy bearer issued after the last new
replica boots must reach a new replica before its original expiry. Otherwise,
recreate that sandbox. Already-expired credentials also require recreation.

Keep the instance encryption key stable across restarts. A changed key can cause
a new credential to be minted, but does not invalidate an existing bearer.

Session teardown, retention reaping, and orphan deletion remain revocation owners.
The host fences cold wakes and waits for registered builds before teardown.
A concurrent wake cannot insert a token after revocation. Cache eviction and process shutdown do not revoke tokens.

## Monitoring

`valet.sandbox.token_rejected` counts rejected known credentials when the durable
engine row still has a sandbox attachment. Labels contain only `reason`, with
values `expired` and `revoked`. Unknown tokens and deleted sessions do not count.
The check includes cold sessions and does not depend on the host cache.

The Grafana provisioning file alerts on an increase within ten minutes. This is
an observed authentication-failure counter, not an inventory of idle sandboxes.
It can also expose replay of a revoked bearer while a new sandbox is attached.
Check API restart and teardown logs to identify the affected session. If its
credential was invalid before upgrade, recreate the sandbox.

## Validation

Unit tests cover adoption beyond 24 hours, principal isolation, key changes,
legacy adoption, revocation, and rejection metrics. A teardown race test holds a
build open while deletion starts. A process test uses separate API fixture
processes and one disk-backed PGlite database. The caller retains the original
bearer and uses real HTTP before restart, after restart, after adoption, and
after teardown. The provider is virtual; this does not replace a live Kubernetes
rollout check.
