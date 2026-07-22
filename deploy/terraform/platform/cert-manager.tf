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
    securityContext               = { fsGroup = 1001 } # IRSA token readable by non-root
  })]
}

resource "kubectl_manifest" "cluster_issuer" {
  yaml_body = yamlencode({
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata   = { name = "letsencrypt" }
    spec = {
      acme = {
        server              = "https://acme-v02.api.letsencrypt.org/directory"
        email               = var.letsencrypt_email
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
