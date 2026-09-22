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

A provider must reject a request before side effects unless all four states can converge. The local provider is always unsupported. Kubernetes remains unsupported until its lifecycle applies and observes the topology plan. Docker reports support only when it has a pinned proxy artifact and CA material source. Operator configuration cannot assert callback or network readiness.

## Hematite contract

The supported callback contract is `hematite-external-authorization-v1`. The compatible Hematite configuration contract is v1 at source commit `35cdd0bc8816afefb4012ba2f9ca66b927c1aa00`. This source commit does not identify an OCI image.

Operators must configure an immutable registry artifact as `image@sha256:<digest>`. There is no default artifact. A mutable tag does not configure the feature. Local acceptance can build the exact source commit and run its local `sha256:<image-id>`. A local image ID never satisfies production configuration.

Hematite sends one `POST /v1/authorize` request. The request has a closed 4 KiB schema:

- version and request ID;
- service `egress` and action `connect`;
- bound session and workload IDs;
- scheme, protocol, canonical host, and port.

The callback rejects extra fields. It does not accept method, path, query, headers, body, SNI, resolved IP, client address, token, credentials, or raw request data. A per-proxy bearer token selects one server-side binding of organization, session, workload, proxy, and contract version. The workload does not receive this token.

This checkpoint always returns `deny` with reason `unsupported_prerequisite`. It marks all callback responses as private and non-cacheable. The callback reads at most 4 KiB and cancels slow or oversized streams at a fixed deadline. It rejects ambiguous HTTP framing before it parses JSON.

Repeated request IDs receive the same bounded denial. Token rotation clears replay state. Expiry and revocation remove the binding before token reuse. Global and per-organization limits reject registry overload. An API restart removes all in-memory bindings and fails closed.

## Durable lifecycle state

The `engine_sessions.managed_egress` column stores a closed JSON shape. It stores the requested identity and the last observed artifact, proxy resources, policy resources, workload selector, and callback binding identity. It does not store callback tokens, token hashes, CA private keys, or other credentials. Invalid or unknown fields fail closed and require re-provision.

A restart reconstructs the managed request from this metadata. It mints a new process-epoch callback token and re-observes the full boundary before it reports `effective=true`. The old token is not registered after restart. Missing proxy material or an incomplete observation returns typed unavailability with an operator diagnostic. The provider must not restore the workload with unmanaged egress.

Each sandbox has an ephemeral CA. Only the proxy receives the private key. Workload provisioning receives only the public trust anchor. Proxy replacement generates a new CA.

## Forced topology plans

### Kubernetes

The plan uses one proxy pod per workload policy domain. The proxy does not share the workload pod or network identity. The provider derives the workload selector from `sandboxCrName(sessionKey)`. This selector matches the `valet.dev/session-id` label in the Sandbox manifest. The callback `workloadId` is authorization identity only and never supplies a Kubernetes selector.

A workload NetworkPolicy selects egress only. It preserves existing workload ingress. It allows only the proxy listener and explicit Valet control-plane CIDRs and ports. It gives the workload no DNS rule and no direct destination route. IPv4 and IPv6 CIDRs are explicit.

A second NetworkPolicy lets the proxy receive only workload listener traffic. It lets the proxy reach selected cluster DNS pods, callback CIDRs, and configured upstream CIDRs. The proxy pod uses a fixed non-root UID and GID, `RuntimeDefault` seccomp, resource limits, no host network, no service account token, no privilege, a read-only root filesystem, and no capabilities. Only the proxy mounts the immutable mode-0400 token Secret.

Readiness requires exactly one workload selector match. It also requires the exact proxy pod, listeners, Secrets, Service, and both NetworkPolicies. The provider uses the server-assigned Service IPs as workload proxy endpoints only after readiness. The workload does not need external DNS. The cluster must report NetworkPolicy enforcement. Unknown or unsupported CNI enforcement fails closed.

### Docker

The plan creates an internal workload network and a distinct outbound network. The workload attaches only to the internal network. A separate proxy container attaches to both networks. It has no host-gateway mapping. Only the proxy mounts the token and configuration volumes. A separate trust volume gives the workload only the public CA certificate.

Each managed Docker resource has an exact server-derived ownership label. Restart adoption rejects name collisions with unmanaged resources. Partial setup removes only resources created by that attempt. Terminal cleanup disconnects and removes the workload first. It then removes the proxy, token, configuration, and trust volumes. It removes the outbound network and then the internal network. Missing resources are successful no-ops.

Valet renders the strict Hematite v1 file with an ordered required allowlist and external authorization. The file sets `dns.passthrough` to an empty list. Bootstrap writes the token and CA key through stdin with mode `0400`. Token, CA, and configuration values do not enter Docker argv, environment, or labels. The proxy exposes each configured HTTP, HTTPS, and tunnel listener without publishing a host port.

Explicit proxy variables are client configuration. They are not the security boundary. The isolated network attachment is the boundary.

## Activation requirements

A later change can activate the provider only after it implements atomic apply, readiness observation, restart adoption, replace, hibernate, cleanup, and deterministic orphan recovery for every planned resource. Cleanup failure must keep the sandbox ineffective and report an error. A restart must not downgrade a requested sandbox to unmanaged.

PR12 must rebase on this checkpoint and connect policy delegation and credentials atomically. Until then, Valet must not publish `egress.connect`, add policy defaults, or return an allow from this callback.
