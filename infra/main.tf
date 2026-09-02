terraform {
  required_version = "~> 1.6"

  # Partial backend config — the bucket name embeds the account ID, which
  # this template doesn't know at apply time (the cross-project bootstrap
  # creates the bucket as `<project-slug>-tfstate-<account-id>`). The
  # operator copies infra/backend.config.example to infra/backend.config
  # (gitignored), fills in the bucket name, and runs:
  #
  #   terraform init -backend-config=backend.config
  #
  # Locking uses S3 conditional writes (Terraform 1.10+ `use_lockfile`).
  # No DynamoDB lock table required.
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.62"
    }
  }
}

# Primary region — where the site bucket and remote state live.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "project-stocks"
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

# CloudFront requires its ACM certificate to live in us-east-1, regardless of
# where the rest of the infrastructure lives.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "project-stocks"
      ManagedBy   = "terraform"
      Environment = "production"
    }
  }
}

locals {
  project = "project-stocks"
}
