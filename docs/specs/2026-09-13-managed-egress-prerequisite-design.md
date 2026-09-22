# Managed Egress Prerequisite

Date: 2026-09-13
Status: implementation checkpoint; inactive

## Boundary

Managed egress is disabled by default. This checkpoint does not publish or evaluate `egress.connect`. It does not claim live enforcement.

The engine contract separates four states:

1. `requested` records sandbox intent.
2. `configured` means the exact callback contract and digest-pinned proxy artifact are present.
3. `ready` means the provider observed the proxy listener, token mount, callback binding, and forced network resources.
4. `effective` persists the exact identity and artifact that hold the boundary.

A provider must reject a request before side effects unless all four states can converge. The local provider is always unsupported. Docker and Kubernetes remain unsupported in this checkpoint because their lifecycle code does not yet apply and observe the topology plans. This is deliberate. Configuration flags cannot override missing structural readiness.

## Hematite contract

The supported callback contract is `hematite-external-authorization-v1`. Operators must configure an OCI artifact by digest. A mutable tag does not configure the feature.

Hematite sends one `POST /v1/authorize` request. The request has a closed 4 KiB schema:

- version and request ID;
- service `egress` and action `connect`;
- bound session and workload IDs;
- scheme, protocol, canonical host, and port.

The callback rejects extra fields. It does not accept method, path, query, headers, body, SNI, resolved IP, client address, token, credentials, or raw request data. A per-proxy bearer token selects one server-side binding of organization, session, workload, proxy, and contract version. The workload does not receive this token.

This checkpoint always returns `deny` with reason `unsupported_prerequisite`. It uses `Cache-Control: no-store` and `Pragma: no-cache`. Repeated request IDs receive the same bounded denial. Token rotation clears replay state. Revocation removes the binding. An API restart removes all in-memory bindings and fails closed.

## Forced topology plans

### Kubernetes

The plan uses one proxy pod per workload policy domain. The proxy does not share the workload pod or network identity. A workload NetworkPolicy allows only the proxy listener and explicit Valet control-plane CIDRs and ports. It gives the workload no DNS rule and no direct destination route.

A second NetworkPolicy lets the proxy receive only workload listener traffic. It lets the proxy reach selected cluster DNS pods, callback CIDRs, and configured upstream CIDRs. The proxy pod uses `hostUsers: false`, no host network, no service account token, no privilege, a read-only root filesystem, and no added capabilities. Only the proxy mounts the immutable mode-0400 token Secret.

### Docker

The plan creates an internal workload network and a distinct outbound network. The workload attaches only to the internal network. A separate proxy container attaches to both networks. It has no host-gateway mapping. Only the proxy mounts the token volume. Cleanup removes the proxy, token volume, outbound network, and internal network.

Explicit proxy variables are client configuration. They are not the security boundary. The isolated network attachment is the boundary.

## Activation requirements

A later change can activate the provider only after it implements atomic apply, readiness observation, restart adoption, replace, hibernate, cleanup, and deterministic orphan recovery for every planned resource. Cleanup failure must keep the sandbox ineffective and report an error. A restart must not downgrade a requested sandbox to unmanaged.

PR12 must rebase on this checkpoint and connect policy delegation and credentials atomically. Until then, Valet must not publish `egress.connect`, add policy defaults, or return an allow from this callback.
