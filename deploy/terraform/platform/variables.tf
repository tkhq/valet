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
