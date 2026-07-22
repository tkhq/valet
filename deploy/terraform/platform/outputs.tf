output "valet_url" {
  value = "https://${local.infra.domain}"
}

output "grafana_url" {
  value = "https://grafana.${local.infra.domain}"
}

output "grafana_admin_password" {
  value     = random_password.grafana_admin.result
  sensitive = true
}
