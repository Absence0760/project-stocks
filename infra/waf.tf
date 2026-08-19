# ----------------------------------------------------------------------------
# WAF — per-IP rate limit on CloudFront
#
# CloudFront ACLs MUST live in us-east-1 (the scope = CLOUDFRONT requirement
# is a hard AWS constraint regardless of where the rest of the stack runs).
# That's why providers.tf in main.tf declares an aws.us_east_1 alias.
#
# Coverage: this WAF sits in front of the CloudFront distribution serving
# the site bucket. The Supabase API is reached directly by the
# browser (NOT proxied through CloudFront in this template's default
# shape) — so the WAF does NOT protect the API. To extend WAF coverage to
# the API path, front the Function URL with a CloudFront /api/* behavior
# + shared secret (see USING.md § "CloudFront → API Gateway shared secret"
# — the same pattern applies to Function URL origins).
#
# Cost: ~$5/month base ACL fee + $1/month per rule + $0.60 per 1M
# requests evaluated. At low scale this is rounding error against a $25
# monthly budget; the rate-limit rule is the cheapest first-line defence
# against per-IP bursts.
# ----------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "frontend" {
  provider = aws.us_east_1
  name     = "${local.project}-frontend-acl"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "RateLimitPerIP"
    priority = 0

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_ip
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.project}-frontend-RateLimitPerIP"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.project}-frontend-acl"
  }
}
