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
