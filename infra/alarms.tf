# ----------------------------------------------------------------------------
# Budget + SNS + per-resource CloudWatch alarms
#
# The bootstrap deliberately does NOT create budgets per project (newly-
# org-created member accounts can't create budgets until "IAM access to
# billing information" is enabled in the account itself — a manual step
# the bootstrap can't perform). Each project owns its own budget here.
#
# Pre-condition: IAM billing access must be enabled in this account before
# the first apply that includes `aws_budgets_budget` — see USING.md § 8
# pre-launch checklist item 2. Until then, this entire file should be
# skipped (var.budget_monthly_usd = 0) or apply fails with
# AccessDeniedException on the budget.
# ----------------------------------------------------------------------------

# Budget alerts go through SNS so a single subscription covers budget +
# per-resource CloudWatch alarms.
resource "aws_sns_topic" "alerts" {
  name = "${local.project}-prod-alerts"
}

# Subscribe operator email if configured. Empty var.budget_alert_email
# means no subscription is created (alarms still fire visibly in the
# console, just nobody is paged).
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.budget_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

# Allow Budgets + CloudWatch to publish to the topic.
data "aws_iam_policy_document" "alerts_publish" {
  statement {
    sid       = "AllowBudgetsAndCloudWatch"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_publish.json
}

# --- Monthly budget --------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd > 0 ? 1 : 0
  name         = "${local.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Forecasted is the only notification that catches a runaway *during* the
  # month — actual lags by up to 24h.
  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 50
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }
}

# --- CloudFront alarms (must live in us-east-1) ----------------------------

resource "aws_cloudwatch_metric_alarm" "cloudfront_5xx" {
  provider            = aws.us_east_1
  alarm_name          = "${local.project}-cloudfront-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = 300
  statistic           = "Average"
  threshold           = 1
  alarm_description   = "CloudFront 5xx rate above 1% over 5 minutes."
  alarm_actions       = [aws_sns_topic.alerts.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.frontend.id
    Region         = "Global"
  }
}
