output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "cluster_ca_data" {
  value = module.eks.cluster_certificate_authority_data
}

output "oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "region" {
  value = var.region
}

output "zone_id" {
  value = var.zone_id
}

output "domain" {
  value = var.domain
}

output "ecr_api_url" {
  value = aws_ecr_repository.this["valet-api"].repository_url
}

output "ecr_sandbox_url" {
  value = aws_ecr_repository.this["valet-sandbox"].repository_url
}

output "cert_manager_irsa_arn" {
  value = module.cert_manager_irsa.iam_role_arn
}

output "external_dns_irsa_arn" {
  value = module.external_dns_irsa.iam_role_arn
}
