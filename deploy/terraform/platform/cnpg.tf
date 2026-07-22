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

# App-user credentials are Terraform-generated and passed INTO CNPG
# (bootstrap.initdb.secret) — never read back from operator-generated
# Secrets, which don't exist at first-apply plan time.
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
