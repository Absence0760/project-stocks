# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file short — it loads into every conversation.

**Stack overview, dev commands, and first-time setup live in `docs/STACK.md`.** Read it before doing anything else here — this file deliberately stays stack-agnostic.

@docs/STACK.md

## How this repo was bootstrapped

This project was started from a template branch in `templates`. Shared scaffolding (`.claude/`, security workflows, `CLAUDE.md` itself, `.gitignore`, etc.) is owned by that repo's `base` branch and is not unique to this project. Stack-specific code, business logic, and `docs/STACK.md` are owned here.

If you find a rule worth applying to *every* future project, propose it for the templates repo's `base` branch — don't fork the convention locally.

## Repo-wide hard rules

- **Secrets** — Real production secrets do **NOT** live in this repo. They live in the private estate repo `Absence0760/infra-secrets` (sibling of this repo under `~/github/`), one subdir per project (`infra-secrets/<project-slug>/*.sops.yaml`), each SOPS-encrypted under that project's own `alias/<project-slug>-sops` AWS KMS key; decryption needs `kms:Decrypt` on that key (access is IAM, not repo membership). Bootstrap a project's slot with `infra-secrets/bin/sops-init.sh --project <slug> --region <region>`. Plaintext siblings (`.env`, `terraform.tfvars`) are gitignored and exist transiently for local dev. Never commit a secret to a project repo (encrypted or not), never `git add -f` one, and never add a SOPS recipient other than the project KMS key without discussing.
- **Local-dev env is committed; real secrets never are.** Stack defaults for local dev go in a **committed `.env.development`** (per workspace), loaded automatically by the dev script, so a fresh clone runs with zero env setup. It may contain *only non-sensitive* values — localhost URLs, default ports, docker-compose default creds (`flakey_app`/`flakey_app`, `minioadmin`), dev-only fallback flags — things that grant access to nothing outside a throwaway local environment, so committing them is harmless. The test of "safe to commit" is **non-sensitivity, not "it's only local"**: anything that authenticates to a real or shared system, or that you reuse elsewhere, is a real secret — keep it SOPS-encrypted (above) or in a gitignored `.env.development.local` (loaded last, so it wins). Don't edit the committed file for machine-local tweaks (it dirties the shared tree); use `.env.development.local`. `.env` stays gitignored — it's the personal / SOPS-plaintext slot.
- **Local-first.** Every part of the app must run on a dev laptop with no cloud account. Each external dependency ships a local equivalent (Postgres/Mailpit/MinIO via docker-compose, a local LLM, a webhook sink) *and* a code default that points at it (`STORAGE=local`, an in-process fallback, the feature off until configured) in the *same* change that introduces the dependency — never make the dev server require a real SaaS credential. Give every service or long-running process a dev script (`dev:core`, `dev:db:up`, `dev:run:<app>`, … — see "Root package.json scripts" below) so no one memorizes raw `docker compose`/tool invocations.
- **CI auth** — CI must use GitHub OIDC against AWS. Never introduce static AWS access keys in workflow files or secrets store.
- **Deploys go through the `production` GitHub environment.** Every repo that ships to a real environment must have a GitHub environment named **`production`** with the operator set as a **required reviewer**, and every deploy job must be gated on `environment: production`. This is the human-in-the-loop that makes the OIDC deploy role load-bearing: the role's trust policy pins the `environment:production` `:sub` claim, so a workflow can only assume it *after* a human approves the run. A deploy path that skips the environment (or an environment with no required reviewer) is a bug — treat it like a missing auth check. See `.github/workflows/deploy.yml.example` (Gate 3) for the pattern; the environment itself is provisioned from the `templates` repo's estate scripts (`new-project-account.sh` for new in-org projects, `backfill-prod-environment.sh` for existing repos).
- **Pre-commit hooks** — `.pre-commit-config.yaml` runs gitleaks on staged changes. Install once with `pre-commit install`. Don't bypass with `--no-verify`.

## Working alongside other Claude sessions

More than one Claude session may run in **this one checkout at the same time** — sharing a single working tree *and* a single git index, so a careless `git add` + `git commit` sweeps up another session's in-flight work. The `.claude/hooks/git-scope-guard.py` PreToolUse hook enforces the rules below; if a git command is denied, its message names the scoped alternative — follow it, don't work around it.

- **Commit each piece of work; never push.** Land every logical unit of work as its own path-scoped commit as you finish it — don't leave the tree dirty across tasks or batch unrelated changes into one commit. **Never `git push`** in this repo; publishing is the operator's call. (No `Co-Authored-By`/generated-by trailer — write commits as a human would.)
- **Commit path-scoped, always:** `git commit -m "…" -- path/to/file ...`. A path-scoped commit records only those paths and ignores anything else staged. Bare `git commit`, `git add -u/-A/.`, `git commit -a`, and `git commit --amend` *with staged changes* are blocked — they snapshot the shared index.
- **Only touch what your task owns.** Don't stage, edit, delete, or `restore` files outside your task. Before committing, `git status` and confirm every path is yours.
- **Never whole-tree:** no `git add .`, `checkout/restore .`, `reset --hard`, `git rm .`, `git stash` (without `-- <path>`), or `git clean -f` — each clobbers across the tree.
- **HEAD moves under you.** Other sessions commit mid-task; your path-scoped commits still stack cleanly. Don't be alarmed if `git log` shows commits you didn't make, or files you didn't change show as modified — leave those alone.
- **For large independent work, prefer a git worktree** (`git worktree add ../<slug> -b <branch>`) — your own tree + index, no sharing, then merge. Subagents doing parallel file edits should pass `isolation: "worktree"`.

## Code organization

- **Group `src/lib` (and equivalents) by topic, not by type.** Loose modules piling up at the `lib/` root is a smell — once there are more than a handful, move them into topical subfolders (`auth/`, `billing/`, `<domain>/`, …). Keep only generated/shared type files (`database.types.ts`, `types.ts`) at the root. **Co-locate each module's test beside it**; cross-cutting guard tests may stay at the root.
- **No preemptive abstraction.** Don't extract a shared helper or component on the *second* use — wait for the *third* caller, then extract. Three similar lines beat a premature wrapper, and a "bug fix" PR should not smuggle in a refactor.
- **Consolidating duplicated UI is a refactor, not a feature — pin it first.** When you fold repeated markup into a shared component, add an e2e test that pins the *rendered* behaviour **before** the extraction, so before/after is provably identical, then extract.
- **Group `.claude/agents/`, `.claude/commands/`, and `docs/` into topical subfolders** once each grows past a flat handful (e.g. `agents/auditors/`, `docs/features/`).
- If the project keeps a structure guard (a test asserting "no loose modules at the lib root", "the unit-test glob recurses", etc.), keep it green — it's the thing that stops the organization eroding. Such a guard is stack-specific (test runner + paths), so write it against your own setup rather than copying one.

## Root package.json scripts — one format, estate-wide

When the repo has a root `package.json`, its `scripts` block is the single entry point for every recurring task, and it follows the format `project-running/package.json` established (that file is the canonical exemplar — read it before restructuring scripts):

- **Group scripts with comment keys**: a `"//-- <group> --": "<one-line description>"` divider entry above each cluster. The description carries the load-bearing facts a session needs (ports, prerequisites, doc pointers), not filler.
- **Namespaced, verb-first, colon-separated names**: `setup[:*]` (one-time bootstrap), `dev:*` (orchestrators like `dev:core`/`dev:full`, then `dev:db:*`, `dev:run:<app>`, per-service groups), `build:<surface>`, `check:<surface>`, `test:<surface>[:unit|:e2e]`, `gen:<what>`. Long-running services reuse the same lifecycle verbs: `up` / `down` / `status` / `logs`.
- **JSON holds one-liners only.** Anything longer delegates to a script under `bin/` or `scripts/`; workspace delegation goes through `pnpm -C apps/<x> <script>`.
- **New scripts join an existing group** (or add a new `//--` divider in the right place) — never append ungrouped entries at the bottom.
- **Keep a `test:scripts` guard** that validates the root script targets (referenced files exist, delegated workspace scripts resolve). project-running's `scripts/check_root_scripts.mjs` is the reference implementation; it's layout-specific, so write yours against your own tree rather than copying it verbatim.

Treat a root scripts block that drifts from this format like any other structure-guard violation: fix the format in the same change that touches it.

## Every code change updates tests + docs in the same change

1. Add or update tests for the workspace you touched. If something is genuinely untestable (config, infra, pure styling), say so explicitly — don't skip silently.
2. Update the relevant file in `docs/` if the change affects architecture, commands, env vars, deployment, or features. A one-line doc edit is still an edit.

Treat "code changed, docs and tests unchanged" as an incomplete task — flag it before handing back.

## Fix bugs at the source — never adjust the test to hide them

When a test fails, the only acceptable resolution paths are:

1. **The test itself is broken** (wrong fixture, missing required field, typo, race in test setup, unique-constraint collision with seed data). Fix the test.
2. **The app has a real bug or missing primitive.** Fix the app code. If the app needs a new affordance for the test to wait deterministically (a `data-ready` attribute backed by a real readiness signal, an exposed status, a broadcast handshake), add it in the app code — it's a real API, not test scaffolding.

There is no third option. These are forbidden because they ship the bug behind a green check:

- Inflating a Playwright `expect` / `toBeVisible` timeout to absorb a flake (`5_000` → `15_000` → `30_000`). Fix whatever makes the page slow.
- `await page.waitForTimeout(N)` between two actions. Wait on a real signal (DOM node, state attribute, network response).
- Bumping `--retries` (or relying on Playwright's `retries: 1`) to mask a real race.
- `test.skip(…)` / `test.fixme(…)` / `test.fail(…)` against a real bug without an open follow-up that names what's broken + when it'll be fixed.
- Loosening strict assertions (`toHaveText('Race armed')` → `toContainText(/arm|connect|ready/i)`) to "absorb variance" — the variance IS the bug.
- Replacing a real wait with a sleep "because the real signal is unreliable" — the real signal needs fixing.

If you spot a candidate fix that fits one of those patterns: stop, surface the underlying app issue, and either fix it in the same session or flag it explicitly to the operator. Don't half-mask it via the test.

## Fix the root cause; recommend the durable fix; don't leave findings dangling

- **Fix the root cause, not the symptom.** The "fix bugs at the source" rule above is the test-specific case of a general one: no masking a real failure anywhere — inflated timeouts, sleeps, blanket retries, swallowed errors, `try/catch` that hides a failure. If you can't fix it now, surface it explicitly; don't half-mask it.
- **Recommend the long-term solution.** When a quick patch and a durable fix diverge, name the durable fix and its tradeoffs even if you also ship the patch — don't let an expedient workaround pass as the answer.
- **No dangling "deferred" / "out-of-scope" findings.** A real issue you surface — in a review, an audit, a code comment, or your own analysis — gets driven to resolution, not left as a passing mention. Default: fix it the same session when it's bounded and you've already diagnosed it. Only when a fix is genuinely too large or risky may you defer — and a deferral is a tracked follow-up (a GitHub issue or Jira ticket — confirm before creating), naming what's broken, the durable fix, and the trigger to do it. Surfacing starts the obligation; it doesn't end it.

## UI verification

Don't spin up the dev server to visually verify UI/frontend changes before reporting a task complete. `pnpm check` + `pnpm test` (or the stack's equivalent — see `docs/STACK.md`) are sufficient; the operator reviews visuals themselves. Only run the dev server if explicitly asked.

## Available Claude tooling

Run these as slash-commands. Each delegates to a specialised agent (`.claude/agents/`).

- `/check` — typecheck + tests + format + lint in one pass.
- `/safe-edit` — workflow for security-sensitive or load-bearing changes.
- `/safe-migration` — DB-schema-change workflow (apply locally, verify RLS, sync types, propose smoke tests).
- `/polish-ui` — typography / layout polish on a target frontend surface.
- `/release-readiness` — go/no-go checklist before tagging.
- `/audit/all` — runs every audit in `audit/`; `/audit/<area>` for a single sweep. Areas: `secrets`, `infra`, `deps`, `xss`, `cost-controls`, `auth`, `accessibility`, `gdpr`, `data-export-completeness`, `account-deletion-completeness`, `cookie-consent`, `third-party-data-flows`.
- `/persona` — runs the bug-hunting persona auditors (`.claude/agents/persona-*.md`): real-world points of view (new user, power user, admin, international user, accessibility, integrator, adversary, data subject) that find logic / UX / domain bugs a code review misses. Each writes a living report to `reviews/<persona>.md` (git-ignored). Protocol + how to add domain personas: `.claude/personas/README.md`.

These ship with placeholder examples and need per-project adaptation — see `.claude/README.md`.

## Where to look

- `docs/STACK.md` — the canonical "what is this and how do I run it" doc (template-owned)
- `docs/` — additional architecture/deployment/security docs (template-owned)
- `.github/workflows/gitleaks.yml` — secret scanning (base-owned)
- `.github/workflows/audit.yml` — weekly `pnpm audit` + auto-issue (base-owned)
- `.github/workflows/security.yml` — CodeQL static analysis + container scanning (base-owned)
- `.github/workflows/scorecard.yml` — OSSF Scorecard (base-owned)
- `.github/workflows/claude.yml` — Claude Code automation on PRs/issues (base-owned)
- `.github/workflows/dependabot-auto-merge.yml` — auto-merges minor/patch Dependabot PRs (base-owned)
- `.github/workflows/dependabot-lockfile.yml` — re-syncs pnpm lockfile on Dependabot PRs (base-owned)
- `.github/dependabot.yml` — dependency update PRs (base-owned)
- `SECURITY.md` — vulnerability reporting policy (base-owned)
