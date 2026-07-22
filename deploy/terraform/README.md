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

OpenTofu works interchangeably — `make eks-push` auto-detects `terraform`
vs `tofu`; substitute `tofu` in the commands below if that's what you run.

## Prerequisites

- Terraform ≥ 1.10 (or OpenTofu ≥ 1.10), AWS CLI authenticated against
  the target account, Docker (for `make eks-push`). Helm itself is not
  required — Terraform drives it.
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
