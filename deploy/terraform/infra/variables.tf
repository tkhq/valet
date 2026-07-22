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
