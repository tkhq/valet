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
