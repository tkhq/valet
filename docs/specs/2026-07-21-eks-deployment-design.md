# EKS deployment for Valet v2 (Terraform + Helm)

**Status:** approved design, 2026-07-21
**Scope:** a shared dev/staging AWS environment running the v2 stack
(`packages/api` + `packages/web` + `packages/sandbox-kubernetes`) on EKS,
provisioned end-to-end with Terraform. Not a production HA design.

This builds on the local Kubernetes reference environment
(`deploy/README.md`, `docs/specs/2026-07-15-kubernetes-deployment-design.md`).
The Helm chart at `deploy/chart/valet` is reused as-is except for one
backward-compatible edit (generic ingress annotations, below).

## Decisions

| Decision | Choice |
|---|---|
| Purpose | Shared dev/staging — persistent, real URLs/TLS, cost-optimized |
| Cluster | EKS 1.31, `terraform-aws-modules/eks`, one managed node group |
| Node arch | **arm64** (Graviton, `m7g.large` ×2, scale 2→4) — native builds from Apple Silicon, no QEMU |
| Database | **CloudNativePG** in-cluster (operator + `Cluster` CR), NOT RDS |
| DB credentials | **Terraform-generated**, passed *into* CNPG via `bootstrap.initdb.secret` — never read back from operator-generated Secrets (avoids first-apply plan-time ordering) |
| Ingress/TLS | NLB → ingress-nginx → cert-manager (Let's Encrypt DNS-01 via Route53) + external-dns |
| App images | ECR repos `valet-api` / `valet-sandbox`, pushed by `make eks-push`, tagged by git SHA |
| Prebuild registry | Chart's bundled `registry:2` StatefulSet stays (retention/GC only works against the bundled registry; `localhost:<nodePort>` kubelet pull works on EKS same as k3s) |
| Monitoring | kube-prometheus-stack (Prometheus + Grafana), Grafana at `grafana.<domain>` |
| TF structure | **Two layers**, separate states: `infra` (AWS) and `platform` (helm provider), S3 backend with native lockfile |

## Layout

```
deploy/terraform/
├── infra/       # VPC, EKS, ECR, IRSA, (uses existing Route53 zone)
└── platform/    # helm_release + kubernetes resources, reads infra outputs
```

Two layers because mixing cluster creation and `helm_release` in one state
is the classic Terraform/EKS footgun: the kubernetes/helm providers cannot
plan against a cluster that does not exist yet, and destroys deadlock.
`platform` consumes `infra` outputs via `terraform_remote_state`.

## Layer 1 — `infra`

- **VPC** (`terraform-aws-modules/vpc`): 2 AZs, public + private subnets,
  single NAT gateway. Subnet tags (`kubernetes.io/role/elb`,
  `kubernetes.io/role/internal-elb`) for NLB discovery.
- **EKS** (`terraform-aws-modules/eks`): K8s 1.31, managed node group
  `m7g.large` (arm64) min 2 / max 4, private subnets. Public API endpoint
  restricted to an allowlist CIDR variable. Addons: EBS CSI driver (IRSA),
  CoreDNS, kube-proxy, VPC CNI.
- **StorageClass**: gp3 set as cluster default (annotation moved off gp2).
  Consumers: CNPG, prebuild-registry PVC, sandbox workspace PVCs.
- **ECR**: `valet-api` and `valet-sandbox` repos, keep-last-10 lifecycle
  policy. Node IAM role's default ECR read access covers pulls — no
  imagePullSecrets needed for app images.
- **IRSA roles**: cert-manager (Route53 `ChangeResourceRecordSets` on the
  zone), external-dns (same zone), EBS CSI. No AWS role for the valet api —
  it only talks to the K8s API (Sandbox CRs), covered by chart RBAC.
- **Route53**: existing hosted zone passed as `zone_id` variable. Records
  are managed at runtime by external-dns, not Terraform.
- **State**: S3 bucket (versioned, encrypted) with Terraform ≥1.10 native
  S3 lockfile — no DynamoDB table.

Variables: `region`, `zone_id`, `domain` (e.g. `valet-dev.example.com`),
`api_allowed_cidrs`, `cluster_name` (default `valet-dev`).

## Layer 2 — `platform`

All in-cluster components via the Terraform **helm provider**
(`helm_release`), `depends_on`-chained in order:

1. **ingress-nginx** — Service `LoadBalancer` with NLB annotations
   (`aws-load-balancer-type: nlb`). One NLB total.
2. **cert-manager** + `ClusterIssuer` (Let's Encrypt prod, DNS-01 via
   Route53, IRSA service-account annotation).
3. **external-dns** — watches Ingresses, upserts records in the zone,
   `--policy upsert-only` off (sync) scoped by `--domain-filter`.
4. **agent-sandbox CRD + controller** — no upstream Helm chart; the
   vendored manifest `deploy/agent-sandbox/<version>/manifest.yaml` (same
   file `make k8s-sandbox-install` applies) is applied via the kubernetes
   provider (`kubernetes_manifest` resources generated from the file, or
   the kubectl-provider equivalent — implementation may pick whichever
   handles CRD ordering cleanly, but it must be the *vendored* manifest,
   not a floating upstream URL).
5. **CloudNativePG**: operator chart, then:
   - `random_password.valet_db` (Terraform-generated, lives in TF state —
     the state bucket is private + encrypted, same posture as the other
     secrets below).
   - `kubernetes_secret` type `kubernetes.io/basic-auth`
     (`username: valet`) in the valet namespace.
   - `Cluster` CR: 2 instances, Postgres 17, gp3 20Gi, `bootstrap.initdb`
     with `database: valet`, `owner: valet`, `secret.name` = the secret
     above. CNPG uses our credentials; the superuser stays
     operator-managed (nothing external needs it).
   - PodMonitor enabled (native CNPG metrics → Prometheus).
   - Rotation: `terraform taint random_password.valet_db` + apply flows to
     both the CNPG secret and the valet release in one pass.
6. **kube-prometheus-stack** — Prometheus (30d/20Gi gp3), Grafana behind
   ingress at `grafana.<domain>` with cert-manager TLS; Grafana admin
   password Terraform-generated. ServiceMonitor/PodMonitor discovery
   cluster-wide.
7. **valet** — `helm_release` with `chart = "${path.module}/../../chart/valet"`,
   values:
   - `api.image.repository` = ECR `valet-api`, `tag` = `var.image_tag`
     (git SHA)
   - `sandbox.image.repository`/`tag` = ECR `valet-sandbox` / `var.image_tag`
   - `postgres.bundled: false`; `externalDatabase.url` composed from known
     values: `postgresql://valet:<pw>@<cnpg-cluster>-rw.<ns>.svc:5432/valet`
   - `registry.bundled: true` (default) — prebuild registry stays in-cluster
   - `ingress.className: nginx`, `ingress.host: valet-dev.<domain>`,
     `ingress.annotations` carrying `cert-manager.io/cluster-issuer`,
     `ingress.tls.secretName: valet-tls` (cert-manager issues it)
   - `api.betterAuthUrl: https://valet-dev.<domain>`
   - `api.secrets.anthropicApiKey` from a Terraform sensitive variable
     (`TF_VAR_anthropic_api_key`); `betterAuthSecret`/`encryptionKey` left
     blank → chart-generated-and-retained, as today

### Required chart edit

`deploy/chart/valet/templates/ingress.yaml` hardcodes
`traefik.ingress.kubernetes.io/router.tls: "true"` and accepts no other
annotations. Add a generic `ingress.annotations` map merged into
`metadata.annotations` (keep the traefik annotation emitted only when
`className == "traefik"`, or fold it into the local values default —
backward compatible either way; golden test updated to match).

## Image publishing — `make eks-push`

`valet-api`/`valet-sandbox` images are built locally today; nothing
publishes them. New target:

```
make eks-push   # AWS_REGION/ECR derived from terraform output or env
```

- `docker build` with the same Dockerfiles as `make k8s-build`, native
  arm64 (no `--platform` flag needed on Apple Silicon).
- Tag `<ecr>/<repo>:$(git rev-parse --short HEAD)`.
- `aws ecr get-login-password | docker login` + push both.
- The SHA feeds `terraform apply -var image_tag=<sha>` in `platform`.

CI publishing is a follow-up, not in scope.

## Runbook

```
make eks-push
cd deploy/terraform/infra    && terraform init && terraform apply
cd ../platform               && terraform init && terraform apply -var image_tag=<sha>
# https://valet-dev.<domain> — first signup becomes org admin
```

Redeploy after a code change: `make eks-push`, then `terraform apply
-var image_tag=<new sha>` in `platform` (helm upgrade of the valet release
only).

## Cost ballpark

EKS control plane $73 + 2×m7g.large ~$115 + NAT ~$35 + NLB ~$18 + EBS ~$5
≈ **~$250/mo**, rising with sandbox activity (each active session is a
pod; node group scales to 4).

## Constraints and out-of-scope

- **api replicas stay 1** — the engine is a stateful singleton (in-memory
  claim loop, WS fan-out); no HA for the api by design.
- Out of scope (YAGNI for dev/staging): multi-AZ HA, CI-driven deploys,
  AWS Secrets Manager, cluster-autoscaler/Karpenter beyond the node
  group's own range, CNPG S3 WAL archiving/backups (one stanza to add
  later).
- Prebuild-registry retention limitation (external registries skip
  retention) is *avoided*, not fixed, by keeping the bundled registry.
- Secrets in TF state: `random_password` values and the Anthropic key
  variable are present in the `platform` state file. Accepted for
  dev/staging given a private encrypted bucket; production would move to
  Secrets Manager + External Secrets Operator.
