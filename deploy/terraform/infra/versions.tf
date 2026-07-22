terraform {
  required_version = ">= 1.10"

  backend "s3" {
    # bucket/key/region supplied via `terraform init -backend-config=...`
    # (see deploy/terraform/README.md). Native S3 lockfile, no DynamoDB.
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region
}
