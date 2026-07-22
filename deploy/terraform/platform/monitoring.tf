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
