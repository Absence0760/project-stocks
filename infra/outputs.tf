output "aws_region" {
  description = "AWS region — surfaced as a GitHub variable so the deploy workflow can read it."
  value       = var.aws_region
}

output "frontend_bucket" {
  description = "S3 bucket that hosts the built frontend. CI uploads to this bucket."
  value       = aws_s3_bucket.frontend.bucket
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID. CI uses this for cache invalidation."
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "The *.cloudfront.net domain, useful while DNS is propagating."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

# The browser talks to Supabase directly — there is no same-origin API origin
# on this distribution. The web build needs this at build time as
# PUBLIC_SUPABASE_URL; export-tf-vars.sh pushes it to a GitHub *variable*.
output "public_supabase_url" {
  description = "Supabase project URL the frontend build targets."
  value       = var.supabase_url
}

output "public_site_url" {
  description = "Public URL of the site."
  value       = "https://${var.domain_name}"
}

# Sensitive — embeds the AWS account ID. export-tf-vars.sh pushes sensitive
# outputs to GitHub *secrets*, read by deploy.yml as
# ${{ secrets.AWS_DEPLOY_ROLE_ARN }}.
output "aws_deploy_role_arn" {
  description = "ARN of the bootstrap-created deploy role that GitHub Actions assumes via OIDC."
  value       = data.aws_iam_role.github_deploy.arn
  sensitive   = true
}
