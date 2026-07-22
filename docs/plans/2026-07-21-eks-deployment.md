# EKS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a shared dev/staging EKS environment for valet v2, provisioned end-to-end with Terraform (two layers) + the existing Helm chart.

**Architecture:** Layer `infra` creates AWS primitives (VPC, EKS arm64, ECR, IRSA); layer `platform` uses the Terraform helm/kubectl providers to install ingress-nginx, cert-manager, external-dns, agent-sandbox, CloudNativePG, kube-prometheus-stack, and the valet chart itself. DB credentials are Terraform-generated and passed *into* CNPG. Spec: `docs/specs/2026-07-21-eks-deployment-design.md`.

**Tech Stack:** Terraform ≥1.10 (S3 native lockfile), terraform-aws-modules/{vpc,eks,iam}, providers hashicorp/{aws,helm,kubernetes,random}, gavinbunney/kubectl, Helm chart `deploy/chart/valet`.

## Global Constraints

- Node arch is **arm64** (m7g.large); all images built natively on Apple Silicon, no `--platform` flags.
- api `replicas` stays 1 (stateful singleton) — never scale it in values.
- `random_password` for the DB uses `special = false` so the DSN needs no URL-encoding.
- CR-shaped resources (ClusterIssuer, CNPG Cluster, agent-sandbox manifest) use `kubectl_manifest` (gavinbunney/kubectl), NOT `kubernetes_manifest` (which requires CRDs at plan time).
- agent-sandbox comes from the **vendored** `deploy/agent-sandbox/v0.5.1/manifest.yaml`, never a remote URL.
- No real secret values in committed files; secrets enter via `TF_VAR_*` env vars.
- Verification for Terraform tasks is `terraform init -backend=false && terraform validate && terraform fmt -check` (no AWS account needed at implement time).
- Chart edits must keep `deploy/chart/valet/test/golden.sh` passing.

---

### Task 1: Chart edit — generic `ingress.annotations`

**Files:**
- Modify: `deploy/chart/valet/templates/ingress.yaml`
- Modify: `deploy/chart/valet/values.yaml` (ingress block, ~line 88)
- Test: `deploy/chart/valet/test/golden.sh`

**Interfaces:**
- Produces: values key `ingress.annotations` (map, default `{}`), rendered into the Ingress `metadata.annotations`. The existing traefik TLS annotation must still render for the default `className: traefik` so local k3s behavior is unchanged. Task 5's valet release depends on this key.

- [ ] **Step 1: Add failing golden assertions**

Append to the assertions section of `deploy/chart/valet/test/golden.sh` (before the final summary/exit, following the existing `helm template ... | grep` style — read neighboring assertions and match their helper usage):

```bash
# Ingress: generic annotations passthrough (EKS/cert-manager, spec 2026-07-21)
helm template valet "$CHART_DIR" \
  --set ingress.className=nginx \
  --set ingress.annotations."cert-manager\.io/cluster-issuer"=letsencrypt \
  --set ingress.tls.secretName=valet-tls \
  > "$TMP_DIR/ingress-nginx.yaml"
grep -q 'cert-manager.io/cluster-issuer: letsencrypt' "$TMP_DIR/ingress-nginx.yaml" \
  || fail "ingress.annotations not rendered"
grep -q 'traefik.ingress.kubernetes.io/router.tls' "$TMP_DIR/ingress-nginx.yaml" \
  && fail "traefik annotation leaked into non-traefik ingress"
pass "ingress annotations passthrough + traefik gated on className"

helm template valet "$CHART_DIR" > "$TMP_DIR/ingress-default.yaml"
grep -q 'traefik.ingress.kubernetes.io/router.tls: "true"' "$TMP_DIR/ingress-default.yaml" \
  || fail "default traefik TLS annotation regressed"
pass "default traefik ingress unchanged"
```

- [ ] **Step 2: Run to verify it fails**

Run: `deploy/chart/valet/test/golden.sh`
Expected: FAIL with "ingress.annotations not rendered" (or the traefik-leak assertion).

- [ ] **Step 3: Implement**

Replace the metadata annotations block in `deploy/chart/valet/templates/ingress.yaml` (lines 8–11):

```yaml
  {{- $annotations := dict }}
  {{- if and .Values.ingress.tls.enabled (eq .Values.ingress.className "traefik") }}
  {{- $_ := set $annotations "traefik.ingress.kubernetes.io/router.tls" "true" }}
  {{- end }}
  {{- range $k, $v := .Values.ingress.annotations }}
  {{- $_ := set $annotations $k (toString $v) }}
  {{- end }}
  {{- with $annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
```

In `values.yaml`, add under `ingress:` (after `className: traefik`):

```yaml
  # Extra Ingress metadata.annotations (e.g. cert-manager.io/cluster-issuer
  # on EKS). The traefik router.tls annotation is emitted automatically
  # only when className is "traefik".
  annotations: {}
```

- [ ] **Step 4: Run golden test to verify it passes**

Run: `deploy/chart/valet/test/golden.sh`
Expected: all `ok - ...` lines including the two new ones; exit 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/chart/valet
git commit -m "feat(chart): generic ingress.annotations, traefik annotation gated on className"
```

---

### Task 2: Terraform layer 1 — `deploy/terraform/infra`

**Files:**
- Create: `deploy/terraform/infra/versions.tf`
- Create: `deploy/terraform/infra/variables.tf`
- Create: `deploy/terraform/infra/main.tf`
- Create: `deploy/terraform/infra/ecr.tf`
- Create: `deploy/terraform/infra/irsa.tf`
- Create: `deploy/terraform/infra/outputs.tf`
- Create: `deploy/terraform/infra/terraform.tfvars.example`

**Interfaces:**
- Produces (outputs consumed by Task 3 via `terraform_remote_state`): `cluster_name`, `cluster_endpoint`, `cluster_ca_data`, `region`, `zone_id`, `domain`, `ecr_api_url`, `ecr_sandbox_url`, `cert_manager_irsa_arn`, `external_dns_irsa_arn`, `oidc_provider_arn`.

- [ ] **Step 1: `versions.tf`**

```hcl
terraform {
  required_version = ">= 1.10"

  backend "s3" {
    # bucket/key/region supplied via `terraform init -backend-config=...`
    # (see deploy/terraform/README.md). Native S3 lockfile, no DynamoDB.
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region
}
```

- [ ] **Step 2: `variables.tf`**

```hcl
variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "EKS cluster name"
  type        = string
  default     = "valet-dev"
}

variable "zone_id" {
  description = "Existing Route53 hosted zone ID (records managed by external-dns)"
  type        = string
}

variable "domain" {
  description = "FQDN for the valet api/web UI, inside the hosted zone (e.g. valet-dev.example.com). Grafana lives at grafana.<domain>."
  type        = string
}

variable "api_allowed_cidrs" {
  description = "CIDRs allowed to reach the public EKS API endpoint"
  type        = list(string)
}

variable "vpc_cidr" {
  description = "VPC CIDR"
  type        = string
  default     = "10.60.0.0/16"
}
```

- [ ] **Step 3: `main.tf` (VPC + EKS)**

```hcl
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.16"

  name = var.cluster_name
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [cidrsubnet(var.vpc_cidr, 4, 0), cidrsubnet(var.vpc_cidr, 4, 1)]
  public_subnets  = [cidrsubnet(var.vpc_cidr, 4, 8), cidrsubnet(var.vpc_cidr, 4, 9)]

  enable_nat_gateway = true
  single_nat_gateway = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = "1.31"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access       = true
  cluster_endpoint_public_access_cidrs = var.api_allowed_cidrs

  # The applying IAM principal gets cluster-admin (dev/staging posture).
  enable_cluster_creator_admin_permissions = true

  cluster_addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni    = {}
    aws-ebs-csi-driver = {
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }
  }

  eks_managed_node_groups = {
    default = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = ["m7g.large"]
      min_size       = 2
      desired_size   = 2
      max_size       = 4
    }
  }
}
```

- [ ] **Step 4: `ecr.tf`**

```hcl
resource "aws_ecr_repository" "this" {
  for_each = toset(["valet-api", "valet-sandbox"])

  name                 = each.key
  image_tag_mutability = "MUTABLE"
  force_delete         = true # dev/staging: allow terraform destroy with images present
}

resource "aws_ecr_lifecycle_policy" "keep_last_10" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
```

- [ ] **Step 5: `irsa.tf`**

```hcl
data "aws_route53_zone" "this" {
  zone_id = var.zone_id
}

module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name             = "${var.cluster_name}-ebs-csi"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }
}

module "cert_manager_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name                     = "${var.cluster_name}-cert-manager"
  attach_cert_manager_policy    = true
  cert_manager_hosted_zone_arns = [data.aws_route53_zone.this.arn]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["cert-manager:cert-manager"]
    }
  }
}

module "external_dns_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.48"

  role_name                     = "${var.cluster_name}-external-dns"
  attach_external_dns_policy    = true
  external_dns_hosted_zone_arns = [data.aws_route53_zone.this.arn]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-dns:external-dns"]
    }
  }
}
```

- [ ] **Step 6: `outputs.tf`**

```hcl
output "cluster_name" { value = module.eks.cluster_name }
output "cluster_endpoint" { value = module.eks.cluster_endpoint }
output "cluster_ca_data" { value = module.eks.cluster_certificate_authority_data }
output "oidc_provider_arn" { value = module.eks.oidc_provider_arn }
output "region" { value = var.region }
output "zone_id" { value = var.zone_id }
output "domain" { value = var.domain }
output "ecr_api_url" { value = aws_ecr_repository.this["valet-api"].repository_url }
output "ecr_sandbox_url" { value = aws_ecr_repository.this["valet-sandbox"].repository_url }
output "cert_manager_irsa_arn" { value = module.cert_manager_irsa.iam_role_arn }
output "external_dns_irsa_arn" { value = module.external_dns_irsa.iam_role_arn }
```

- [ ] **Step 7: `terraform.tfvars.example`**

```hcl
region            = "us-east-1"
cluster_name      = "valet-dev"
zone_id           = "Z0000000EXAMPLE"
domain            = "valet-dev.example.com"
api_allowed_cidrs = ["203.0.113.7/32"]
```

- [ ] **Step 8: Validate**

Run:
```bash
cd deploy/terraform/infra
terraform init -backend=false
terraform validate
terraform fmt -check -recursive
```
Expected: `Success! The configuration is valid.`, fmt silent. (First init downloads modules/providers; needs network.)

- [ ] **Step 9: Commit**

```bash
git add deploy/terraform/infra
git commit -m "feat(deploy): terraform infra layer — vpc, eks (arm64), ecr, irsa"
```

---

### Task 3: Platform layer scaffolding + ingress/DNS/TLS stack

**Files:**
- Create: `deploy/terraform/platform/versions.tf`
- Create: `deploy/terraform/platform/variables.tf`
- Create: `deploy/terraform/platform/remote-state.tf`
- Create: `deploy/terraform/platform/storage.tf`
- Create: `deploy/terraform/platform/ingress-nginx.tf`
- Create: `deploy/terraform/platform/cert-manager.tf`
- Create: `deploy/terraform/platform/external-dns.tf`

**Interfaces:**
- Consumes: infra outputs (Task 2) via `data.terraform_remote_state.infra.outputs.*`.
- Produces (used by Tasks 4–5): `local.infra` shorthand, `kubernetes_namespace.valet` (name `valet`), helm/kubernetes/kubectl providers configured, gp3 default StorageClass, `kubectl_manifest.cluster_issuer` (ClusterIssuer named `letsencrypt`), `helm_release.ingress_nginx` (className `nginx`), `helm_release.cert_manager`.

- [ ] **Step 1: `versions.tf`** (providers + auth against the infra cluster)

```hcl
terraform {
  required_version = ">= 1.10"

  backend "s3" {
    use_lockfile = true
  }

  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.80" }
    helm       = { source = "hashicorp/helm", version = "~> 2.16" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.35" }
    kubectl    = { source = "gavinbunney/kubectl", version = "~> 1.19" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

locals {
  infra = data.terraform_remote_state.infra.outputs
}

provider "aws" {
  region = local.infra.region
}

locals {
  k8s_auth = {
    host                   = local.infra.cluster_endpoint
    cluster_ca_certificate = base64decode(local.infra.cluster_ca_data)
    exec_args = [
      "eks", "get-token",
      "--cluster-name", local.infra.cluster_name,
      "--region", local.infra.region,
    ]
  }
}

provider "kubernetes" {
  host                   = local.k8s_auth.host
  cluster_ca_certificate = local.k8s_auth.cluster_ca_certificate
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = local.k8s_auth.exec_args
  }
}

provider "helm" {
  kubernetes {
    host                   = local.k8s_auth.host
    cluster_ca_certificate = local.k8s_auth.cluster_ca_certificate
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = local.k8s_auth.exec_args
    }
  }
}

provider "kubectl" {
  host                   = local.k8s_auth.host
  cluster_ca_certificate = local.k8s_auth.cluster_ca_certificate
  load_config_file       = false
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = local.k8s_auth.exec_args
  }
}
```

- [ ] **Step 2: `variables.tf`**

```hcl
variable "infra_state_bucket" {
  description = "S3 bucket holding the infra layer's state"
  type        = string
}

variable "infra_state_key" {
  description = "State key of the infra layer"
  type        = string
  default     = "valet-dev/infra.tfstate"
}

variable "infra_state_region" {
  description = "Region of the state bucket"
  type        = string
  default     = "us-east-1"
}

variable "image_tag" {
  description = "Git SHA tag for valet-api/valet-sandbox images (from `make eks-push`)"
  type        = string
}

variable "anthropic_api_key" {
  description = "Anthropic API key for the valet api (set via TF_VAR_anthropic_api_key)"
  type        = string
  sensitive   = true
}

variable "letsencrypt_email" {
  description = "Registration email for the Let's Encrypt account"
  type        = string
}
```

- [ ] **Step 3: `remote-state.tf`**

```hcl
data "terraform_remote_state" "infra" {
  backend = "s3"
  config = {
    bucket = var.infra_state_bucket
    key    = var.infra_state_key
    region = var.infra_state_region
  }
}
```

- [ ] **Step 4: `storage.tf`** (gp3 default; demote gp2)

```hcl
resource "kubernetes_annotations" "gp2_not_default" {
  api_version = "storage.k8s.io/v1"
  kind        = "StorageClass"
  metadata {
    name = "gp2"
  }
  annotations = {
    "storageclass.kubernetes.io/is-default-class" = "false"
  }
  force = true
}

resource "kubernetes_storage_class" "gp3" {
  metadata {
    name = "gp3"
    annotations = {
      "storageclass.kubernetes.io/is-default-class" = "true"
    }
  }
  storage_provisioner    = "ebs.csi.aws.com"
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true
  parameters = {
    type = "gp3"
  }
  depends_on = [kubernetes_annotations.gp2_not_default]
}
```

- [ ] **Step 5: `ingress-nginx.tf`**

```hcl
resource "helm_release" "ingress_nginx" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = "4.12.0"
  namespace        = "ingress-nginx"
  create_namespace = true

  values = [yamlencode({
    controller = {
      service = {
        annotations = {
          "service.beta.kubernetes.io/aws-load-balancer-type"                              = "nlb"
          "service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled" = "true"
        }
      }
      # WS-heavy app (session streams): don't cut idle streams too early.
      config = {
        proxy-read-timeout = "3600"
        proxy-send-timeout = "3600"
      }
    }
  })]
}
```

- [ ] **Step 6: `cert-manager.tf`**

```hcl
resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = "v1.16.3"
  namespace        = "cert-manager"
  create_namespace = true

  values = [yamlencode({
    crds = { enabled = true }
    serviceAccount = {
      annotations = {
        "eks.amazonaws.com/role-arn" = local.infra.cert_manager_irsa_arn
      }
    }
    # DNS-01 self-check must resolve via public DNS, not cluster DNS.
    dns01RecursiveNameserversOnly = true
    dns01RecursiveNameservers     = "1.1.1.1:53,8.8.8.8:53"
    securityContext = { fsGroup = 1001 } # IRSA token readable by non-root
  })]
}

resource "kubectl_manifest" "cluster_issuer" {
  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata   = { name = "letsencrypt" }
    spec = {
      acme = {
        server = "https://acme-v02.api.letsencrypt.org/directory"
        email  = var.letsencrypt_email
        privateKeySecretRef = { name = "letsencrypt-account-key" }
        solvers = [{
          dns01 = {
            route53 = {
              region       = local.infra.region
              hostedZoneID = local.infra.zone_id
            }
          }
        }]
      }
    }
  })

  depends_on = [helm_release.cert_manager]
}
```

- [ ] **Step 7: `external-dns.tf`**

```hcl
resource "helm_release" "external_dns" {
  name             = "external-dns"
  repository       = "https://kubernetes-sigs.github.io/external-dns"
  chart            = "external-dns"
  version          = "1.15.0"
  namespace        = "external-dns"
  create_namespace = true

  values = [yamlencode({
    provider      = { name = "aws" }
    policy        = "sync"
    txtOwnerId    = local.infra.cluster_name
    domainFilters = [local.infra.domain]
    extraArgs     = ["--aws-zone-type=public"]
    serviceAccount = {
      annotations = {
        "eks.amazonaws.com/role-arn" = local.infra.external_dns_irsa_arn
      }
    }
  })]

  depends_on = [helm_release.ingress_nginx]
}
```

- [ ] **Step 8: Validate**

Run:
```bash
cd deploy/terraform/platform
terraform init -backend=false
terraform validate
terraform fmt -check -recursive
```
Expected: `Success! The configuration is valid.` (Note: `terraform validate` does not contact the cluster; provider exec auth is only exercised at plan/apply.)

- [ ] **Step 9: Commit**

```bash
git add deploy/terraform/platform
git commit -m "feat(deploy): terraform platform layer — providers, gp3, ingress-nginx, cert-manager, external-dns"
```

---

### Task 4: agent-sandbox + CloudNativePG

**Files:**
- Create: `deploy/terraform/platform/agent-sandbox.tf`
- Create: `deploy/terraform/platform/cnpg.tf`

**Interfaces:**
- Consumes: providers/locals from Task 3.
- Produces: `kubectl_manifest.agent_sandbox` (for_each over vendored manifest docs); `kubernetes_namespace.valet`; `random_password.valet_db`; `kubernetes_secret.valet_db` (name `valet-db-app`, ns `valet`); CNPG `Cluster` named `valet-pg` in ns `valet`; `local.database_url` = `postgresql://valet:<pw>@valet-pg-rw.valet.svc:5432/valet` (consumed by Task 5's valet release).

- [ ] **Step 1: `agent-sandbox.tf`**

```hcl
data "kubectl_file_documents" "agent_sandbox" {
  content = file("${path.module}/../../agent-sandbox/v0.5.1/manifest.yaml")
}

resource "kubectl_manifest" "agent_sandbox" {
  for_each  = data.kubectl_file_documents.agent_sandbox.manifests
  yaml_body = each.value

  # CRDs and webhook certs in one manifest: apply server-side, tolerate
  # the controller re-writing caBundle fields.
  server_side_apply = true
  wait              = true
}
```

- [ ] **Step 2: `cnpg.tf`**

```hcl
resource "helm_release" "cnpg_operator" {
  name             = "cnpg"
  repository       = "https://cloudnative-pg.github.io/charts"
  chart            = "cloudnative-pg"
  version          = "0.23.0"
  namespace        = "cnpg-system"
  create_namespace = true
}

resource "kubernetes_namespace" "valet" {
  metadata {
    name = "valet"
  }
}

resource "random_password" "valet_db" {
  length  = 32
  special = false # keeps the DSN free of URL-encoding
}

resource "kubernetes_secret" "valet_db" {
  metadata {
    name      = "valet-db-app"
    namespace = kubernetes_namespace.valet.metadata[0].name
    labels = {
      "cnpg.io/reload" = "true"
    }
  }
  type = "kubernetes.io/basic-auth"
  data = {
    username = "valet"
    password = random_password.valet_db.result
  }
}

resource "kubectl_manifest" "valet_pg" {
  yaml_body = yamlencode({
    apiVersion = "postgresql.cnpg.io/v1"
    kind       = "Cluster"
    metadata = {
      name      = "valet-pg"
      namespace = kubernetes_namespace.valet.metadata[0].name
    }
    spec = {
      instances = 2
      imageName = "ghcr.io/cloudnative-pg/postgresql:17"
      storage = {
        size         = "20Gi"
        storageClass = kubernetes_storage_class.gp3.metadata[0].name
      }
      bootstrap = {
        initdb = {
          database = "valet"
          owner    = "valet"
          secret   = { name = kubernetes_secret.valet_db.metadata[0].name }
        }
      }
      monitoring = { enablePodMonitor = true }
    }
  })

  depends_on = [helm_release.cnpg_operator]
}

locals {
  database_url = "postgresql://valet:${random_password.valet_db.result}@valet-pg-rw.${kubernetes_namespace.valet.metadata[0].name}.svc:5432/valet"
}
```

- [ ] **Step 3: Validate**

Run (from `deploy/terraform/platform`): `terraform validate && terraform fmt -check`
Expected: valid, fmt silent.

- [ ] **Step 4: Commit**

```bash
git add deploy/terraform/platform/agent-sandbox.tf deploy/terraform/platform/cnpg.tf
git commit -m "feat(deploy): platform — vendored agent-sandbox apply + cnpg with terraform-owned credentials"
```

---

### Task 5: Monitoring + the valet release

**Files:**
- Create: `deploy/terraform/platform/monitoring.tf`
- Create: `deploy/terraform/platform/valet.tf`
- Create: `deploy/terraform/platform/outputs.tf`

**Interfaces:**
- Consumes: `local.database_url`, `local.infra`, `kubernetes_namespace.valet`, ClusterIssuer `letsencrypt`, chart key `ingress.annotations` (Task 1).
- Produces: `helm_release.valet`; outputs `valet_url`, `grafana_url`.

- [ ] **Step 1: `monitoring.tf`**

```hcl
resource "random_password" "grafana_admin" {
  length  = 24
  special = false
}

resource "helm_release" "kube_prometheus_stack" {
  name             = "monitoring"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "67.9.0"
  namespace        = "monitoring"
  create_namespace = true

  values = [yamlencode({
    prometheus = {
      prometheusSpec = {
        retention = "30d"
        storageSpec = {
          volumeClaimTemplate = {
            spec = {
              storageClassName = kubernetes_storage_class.gp3.metadata[0].name
              resources        = { requests = { storage = "20Gi" } }
            }
          }
        }
        # Discover ServiceMonitors/PodMonitors cluster-wide (CNPG, valet).
        serviceMonitorSelectorNilUsesHelmValues = false
        podMonitorSelectorNilUsesHelmValues     = false
      }
    }
    grafana = {
      adminPassword = random_password.grafana_admin.result
      ingress = {
        enabled          = true
        ingressClassName = "nginx"
        annotations = {
          "cert-manager.io/cluster-issuer" = "letsencrypt"
        }
        hosts = ["grafana.${local.infra.domain}"]
        tls = [{
          secretName = "grafana-tls"
          hosts      = ["grafana.${local.infra.domain}"]
        }]
      }
    }
  })]

  depends_on = [helm_release.ingress_nginx, kubectl_manifest.cluster_issuer]
}
```

- [ ] **Step 2: `valet.tf`**

```hcl
resource "helm_release" "valet" {
  name      = "valet"
  chart     = "${path.module}/../../chart/valet"
  namespace = kubernetes_namespace.valet.metadata[0].name

  values = [yamlencode({
    api = {
      image = {
        repository = local.infra.ecr_api_url
        tag        = var.image_tag
        pullPolicy = "IfNotPresent"
      }
      betterAuthUrl = "https://${local.infra.domain}"
    }
    sandbox = {
      image = {
        repository = local.infra.ecr_sandbox_url
        tag        = var.image_tag
      }
    }
    postgres = { bundled = false }
    ingress = {
      enabled   = true
      className = "nginx"
      host      = local.infra.domain
      annotations = {
        "cert-manager.io/cluster-issuer" = "letsencrypt"
      }
      tls = {
        enabled    = true
        secretName = "valet-tls"
      }
    }
  })]

  # Secrets via set_sensitive so they don't land in the rendered values diff.
  set_sensitive {
    name  = "externalDatabase.url"
    value = local.database_url
  }
  set_sensitive {
    name  = "api.secrets.anthropicApiKey"
    value = var.anthropic_api_key
  }

  depends_on = [
    kubectl_manifest.agent_sandbox,
    kubectl_manifest.valet_pg,
    kubectl_manifest.cluster_issuer,
    helm_release.ingress_nginx,
  ]
}
```

- [ ] **Step 3: `outputs.tf`**

```hcl
output "valet_url" { value = "https://${local.infra.domain}" }
output "grafana_url" { value = "https://grafana.${local.infra.domain}" }
output "grafana_admin_password" {
  value     = random_password.grafana_admin.result
  sensitive = true
}
```

- [ ] **Step 4: Validate**

Run (from `deploy/terraform/platform`): `terraform validate && terraform fmt -check`
Expected: valid, fmt silent.

- [ ] **Step 5: Commit**

```bash
git add deploy/terraform/platform
git commit -m "feat(deploy): platform — kube-prometheus-stack + valet release wired to ecr/cnpg/nginx"
```

---

### Task 6: `make eks-push` + runbook README

**Files:**
- Modify: `Makefile` (after the `k8s-*` block, ~line 245; add `eks-push` to the `.PHONY` list on line 26)
- Create: `deploy/terraform/README.md`

**Interfaces:**
- Consumes: ECR repo URLs (from `terraform output` in `deploy/terraform/infra`), Dockerfiles `docker/Dockerfile.api` / `docker/Dockerfile.sandbox-k8s`.
- Produces: images tagged `<ecr>/<repo>:<short-sha>`; the sha printed for `terraform apply -var image_tag=...`.

- [ ] **Step 1: Makefile target**

```makefile
EKS_TF_INFRA_DIR ?= deploy/terraform/infra
EKS_IMAGE_TAG ?= $(shell git rev-parse --short HEAD)

eks-push: ## Build (native arm64) + push valet-api/valet-sandbox to ECR, tagged by git sha
	@ECR_API=$$(terraform -chdir=$(EKS_TF_INFRA_DIR) output -raw ecr_api_url); \
	ECR_SANDBOX=$$(terraform -chdir=$(EKS_TF_INFRA_DIR) output -raw ecr_sandbox_url); \
	REGION=$$(terraform -chdir=$(EKS_TF_INFRA_DIR) output -raw region); \
	REGISTRY=$${ECR_API%%/*}; \
	echo "$(GREEN)Logging in to $$REGISTRY$(NC)"; \
	aws ecr get-login-password --region $$REGION | docker login --username AWS --password-stdin $$REGISTRY; \
	echo "$(GREEN)Building $$ECR_API:$(EKS_IMAGE_TAG) from docker/Dockerfile.api$(NC)"; \
	docker build -f docker/Dockerfile.api -t $$ECR_API:$(EKS_IMAGE_TAG) .; \
	echo "$(GREEN)Building $$ECR_SANDBOX:$(EKS_IMAGE_TAG) from docker/Dockerfile.sandbox-k8s$(NC)"; \
	docker build -f docker/Dockerfile.sandbox-k8s -t $$ECR_SANDBOX:$(EKS_IMAGE_TAG) .; \
	docker push $$ECR_API:$(EKS_IMAGE_TAG); \
	docker push $$ECR_SANDBOX:$(EKS_IMAGE_TAG); \
	echo "$(GREEN)Pushed tag $(EKS_IMAGE_TAG) — apply with: terraform -chdir=deploy/terraform/platform apply -var image_tag=$(EKS_IMAGE_TAG)$(NC)"
```

Add `eks-push` to the `.PHONY` declaration (line 26 area, alongside the `k8s-*` targets).

- [ ] **Step 2: Verify target parses**

Run: `make -n eks-push 2>&1 | head -5`
Expected: the recipe echoes (terraform -chdir output commands visible), no `*** missing separator` / syntax errors. (Full execution needs AWS creds + applied infra; not required here.)

- [ ] **Step 3: `deploy/terraform/README.md`**

Write the runbook (complete content):

```markdown
# EKS dev/staging environment (Terraform)

Two-layer Terraform for running Valet v2 on EKS. Design:
`docs/specs/2026-07-21-eks-deployment-design.md`. For the *local*
Kubernetes reference environment, see `deploy/README.md` instead.

- `infra/` — VPC, EKS (arm64 m7g.large ×2–4), ECR, IRSA roles.
- `platform/` — everything in-cluster via the helm/kubectl providers:
  ingress-nginx (NLB), cert-manager (+ Let's Encrypt `letsencrypt`
  ClusterIssuer, Route53 DNS-01), external-dns, agent-sandbox (vendored
  `deploy/agent-sandbox/v0.5.1/manifest.yaml`), CloudNativePG (operator +
  2-instance `valet-pg` cluster, Terraform-generated app credentials),
  kube-prometheus-stack, and the valet chart (`deploy/chart/valet`).

## Prerequisites

- Terraform ≥ 1.10, AWS CLI authenticated against the target account,
  Docker (for `make eks-push`), Helm not required (Terraform drives it).
- An existing Route53 hosted zone for the domain.
- A private, versioned S3 bucket for Terraform state (create once, out of
  band). State contains secrets (DB password, Anthropic key) — keep it
  encrypted and access-restricted.

## First-time bring-up

```sh
# 1. Infra layer
cd deploy/terraform/infra
cp terraform.tfvars.example terraform.tfvars   # edit values
terraform init \
  -backend-config="bucket=<state-bucket>" \
  -backend-config="key=valet-dev/infra.tfstate" \
  -backend-config="region=<region>"
terraform apply

# 2. Build + push images (from repo root; needs the infra outputs above)
make eks-push          # prints the image tag (git short sha)

# 3. Platform layer
cd deploy/terraform/platform
terraform init \
  -backend-config="bucket=<state-bucket>" \
  -backend-config="key=valet-dev/platform.tfstate" \
  -backend-config="region=<region>"
export TF_VAR_anthropic_api_key=sk-ant-...
terraform apply \
  -var infra_state_bucket=<state-bucket> \
  -var image_tag=<sha from step 2> \
  -var letsencrypt_email=<you@example.com>
```

Then open `https://<domain>` — first signup becomes the org admin.
Grafana is at `https://grafana.<domain>` (user `admin`, password:
`terraform output grafana_admin_password`).

## Deploying a code change

```sh
make eks-push
terraform -chdir=deploy/terraform/platform apply -var image_tag=<new sha> ...
```

Only the valet helm release changes.

## Rotating the DB password

```sh
terraform -chdir=deploy/terraform/platform taint random_password.valet_db
terraform -chdir=deploy/terraform/platform apply ...
```

Flows to the CNPG secret and the valet release in one apply.

## Notes

- The api Deployment is a stateful singleton — `replicas` stays 1.
- The sandbox prebuild registry is the chart's bundled in-cluster
  `registry:2` (retention/GC only works against the bundled registry).
- kubectl access: `aws eks update-kubeconfig --name valet-dev --region
  <region>` — but prefer Terraform for all standing changes.
- Tear-down: `terraform destroy` in `platform`, then `infra`. Sandbox
  namespace PVCs/CRs created at runtime by sessions may need manual
  deletion first (`kubectl -n valet-sandboxes delete sandboxes --all`).
```

- [ ] **Step 4: Commit**

```bash
git add Makefile deploy/terraform/README.md
git commit -m "feat(deploy): make eks-push + eks terraform runbook"
```

---

### Task 7: Cross-references + final verification

**Files:**
- Modify: `deploy/README.md` (top of file)
- Modify: `docs/specs/2026-07-21-eks-deployment-design.md` (only if implementation deviated)

**Interfaces:** none — documentation closure.

- [ ] **Step 1: Pointer in `deploy/README.md`**

After the first paragraph, add:

```markdown
For the **AWS/EKS dev-staging environment** (Terraform-provisioned), see
`deploy/terraform/README.md` — this document covers only the local
Rancher Desktop reference environment.
```

- [ ] **Step 2: Full verification sweep**

Run:
```bash
deploy/chart/valet/test/golden.sh
terraform -chdir=deploy/terraform/infra validate
terraform -chdir=deploy/terraform/platform validate
terraform fmt -check -recursive deploy/terraform
make -n eks-push >/dev/null && echo makefile-ok
```
Expected: golden all-ok, both validates succeed, fmt silent, `makefile-ok`.

- [ ] **Step 3: Record deviations**

If any implementation detail diverged from the design spec (provider versions, chart versions, resource names), append a short "Deviations" section to `docs/specs/2026-07-21-eks-deployment-design.md`.

- [ ] **Step 4: Commit**

```bash
git add deploy/README.md docs/specs/2026-07-21-eks-deployment-design.md
git commit -m "docs(deploy): cross-link eks runbook; record deviations"
```
