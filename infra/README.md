# Infrastructure

Terraform configuration for the project's AWS resources.

## What it creates

- **S3 bucket** hosting the prerendered SvelteKit site
- **CloudFront distribution** with Origin Access Control in front of the bucket, attached to a per-IP rate-limit WAF
- **WAFv2 Web ACL** (us-east-1, CloudFront scope) — first-line per-IP rate limit
- **ACM certificate** (in us-east-1, as CloudFront requires) with DNS validation
- **Route 53 records** for the apex domain, `www`, and cert validation
- **No compute.** The backend is Supabase (hosted), which the browser talks to
  directly. This stack is purely static hosting — adapted from the estate's
  `web-minimal` template with its Lambda origin, `/api/*` behaviour and
  CloudFront→origin shared secret removed.
- **Project-scoped deploy policy** attached to the bootstrap-created OIDC role (no provider or role creation here)
- **AWS Budget** + **SNS topic** + CloudWatch alarm on CloudFront 5xx

## Architecture note: Function URL is reached directly

Because there is no API origin on this distribution, the WAF and its per-IP
rate limit cover everything this stack serves. Supabase is reached directly by
the browser and is protected by its own RLS policies and rate limits, not by
anything here — the security boundary for data access is the database, which is
why every table carries both a policy and a grant.

## Bootstrap workflow

This template assumes the **cross-project bootstrap** has already run for this project's AWS account. The bootstrap (in `~/repos/templates/scripts/new-project-account.sh`) creates:

- The AWS sub-account itself (under your org)
- Tfstate S3 bucket + KMS for sops + Route 53 child zone
- GitHub OIDC provider + scoped deploy role (named `<bootstrap-slug>-deploy`, trust policy gated on `:sub = repo:<owner>/<repo>:environment:production`)
- GitHub `production` environment with you as required reviewer
- Branch protection on `main` (PR required, linear history, no force-push, no deletions, conversation resolution)

This Terraform stack **looks up** that deploy role via `data "aws_iam_role" "github_deploy"` and attaches the per-resource policy — it does NOT create the OIDC provider or role.

If the bootstrap hasn't run yet:

```bash
cd ~/repos/templates
cp infra/bootstrap/projects/example.tfvars infra/bootstrap/projects/<your-slug>.tfvars
$EDITOR infra/bootstrap/projects/<your-slug>.tfvars
./scripts/new-project-account.sh <your-slug> --plan   # dry-run
./scripts/new-project-account.sh <your-slug>          # apply (~3-5 min)
```

The script's final summary prints the account ID, tfstate bucket, KMS alias, and deploy role ARN — you'll need the tfstate bucket name for `backend.config` below.

## Prerequisites

- Terraform `~> 1.6` (the pin in `main.tf`)
- AWS CLI v2 configured with credentials for the project sub-account (`aws sso login --profile <project>`)
- Bootstrap has been run for this project (see above)
- IAM "Billing access" enabled on the member account (one-time root toggle; required for `aws_budgets_budget`)

## First-time setup

```bash
# 1. Configure the partial backend (bucket name embeds account ID).
cp infra/backend.config.example infra/backend.config
$EDITOR infra/backend.config        # fill in <bootstrap-slug>-tfstate-<account-id>

# 2. Configure project variables.
cp infra/terraform.tfvars.example infra/terraform.tfvars
$EDITOR infra/terraform.tfvars
#    bootstrap_slug MUST match the slug new-project-account.sh was run with.
#    domain_name + route53_zone_id come from the bootstrap output (child zone).

# 3. Init + apply.
cd infra
terraform init -backend-config=backend.config
terraform plan
terraform apply
```

First apply takes ~15 minutes (CloudFront propagation + ACM validation).

## Wire CI

After `terraform apply` succeeds, push the outputs into GitHub repo variables + secrets so the deploy workflows can read them:

```bash
# From repo root.
~/repos/templates/scripts/export-tf-vars.sh infra/
```

The script splits Terraform outputs: anything marked `sensitive = true` (currently just `aws_deploy_role_arn`) goes to GitHub *secrets*; the rest go to *variables*. Re-run after any apply that renames resources.

## Updating

```bash
cd infra
terraform plan        # always; CloudFront drift can be subtle
terraform apply
~/repos/templates/scripts/export-tf-vars.sh infra/   # if any output value changed
```

## Upgrading from the pre-bootstrap shape

Versions of this template before commit `c919538` created the OIDC provider + deploy role IN this Terraform stack (`aws_iam_openid_connect_provider.github` + `aws_iam_role.github_actions`). The current shape looks them up from the cross-project bootstrap instead.

If you have state from the old shape, migrate in this order — **plan everything before applying; touching IAM state is hard to roll back**:

```bash
# 1. Run the bootstrap if you haven't (no-op if you have).
cd ~/repos/templates
./scripts/new-project-account.sh <your-slug>
```

The bootstrap will refuse to create the OIDC provider if one already exists at `arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com` (only one per account is allowed). If that happens, import the existing provider into the bootstrap state instead:

```bash
cd ~/repos/templates/infra/bootstrap/2-baseline
terraform workspace select <your-slug>
terraform import 'module.baseline.aws_iam_openid_connect_provider.github' \
  arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com
terraform plan        # should now be a no-op
```

Then in **this** repo's `infra/`:

```bash
# 2. Pull the new template code (you've presumably already done this).
git pull   # or: rebase your local changes onto the new oidc.tf shape

# 3. Remove the now-redundant resources from THIS state. They still exist
#    in AWS, but they shouldn't be managed by this stack anymore.
cd infra
terraform state rm aws_iam_role_policy.github_actions
terraform state rm aws_iam_role.github_actions
terraform state rm aws_iam_openid_connect_provider.github

# 4. Delete the now-orphaned AWS resources via console or CLI. Order matters:
#    detach the inline policy + role (4a) BEFORE deleting the role + provider.
aws iam delete-role-policy --role-name <project>-github-actions --policy-name <project>-github-actions-deploy
aws iam delete-role --role-name <project>-github-actions
# Provider: delete ONLY if you imported it into bootstrap (otherwise leave it).
# aws iam delete-open-id-connect-provider --open-id-connect-provider-arn arn:...

# 5. Update terraform.tfvars: add `bootstrap_slug = "<your-slug>"`.

# 6. terraform plan — should show:
#      + aws_iam_policy.github_deploy            (project's per-resource policy)
#      + aws_iam_role_policy_attachment.github_deploy   (attach to bootstrap role)
#    and no destroys.
terraform plan
terraform apply

# 7. Push the renamed/secret-ified outputs to gh:
~/repos/templates/scripts/export-tf-vars.sh .
```

**Workflow update**: the deploy workflows now consume `${{ secrets.AWS_DEPLOY_ROLE_ARN }}` instead of `${{ vars.AWS_ROLE_TO_ASSUME }}`. If you have an old `AWS_ROLE_TO_ASSUME` repo variable, delete it after verifying the new secret works (`gh variable delete AWS_ROLE_TO_ASSUME`).

**GitHub environment**: the bootstrap-created deploy role's trust policy pins `:sub = repo:<owner>/<repo>:environment:production`. The deploy workflows already declare `environment: production` on the deploy job, so no workflow change is needed — but verify the `production` environment exists in Settings → Environments with you as a Required reviewer. If it doesn't (the bootstrap may have run before commit `67c085c`), create it manually or re-run the bootstrap.

## Tearing down

```bash
cd infra
terraform destroy
```

Removes everything this Terraform created. The tfstate bucket itself lives in the bootstrap and survives — remove via `~/repos/templates/infra/bootstrap/2-baseline` (with `prevent_destroy` loosened first).
