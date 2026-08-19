# Base scaffolding

You're on the `base` branch of the `templates` repo. This branch holds only the shared scaffolding that every template inherits — there's no app code here.

**To start a new project, clone a template branch instead** — see `main` for the index.

## What lives here

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | Repo-wide Claude Code guidance (stack-agnostic; per-template stack details go in `docs/STACK.md`). |
| `.claude/settings.json` | Default permissions allowlist + denylist for Claude Code. |
| `.github/workflows/security.yml` | CodeQL static analysis on every push/PR + weekly cron. |
| `.github/dependabot.yml` | Grouped weekly dependency PRs (npm, pip, terraform, GitHub Actions). |
| `.gitignore` | Common patterns (node_modules, dist, .env, .terraform, etc.). |
| `.editorconfig` | 2-space default, 4 for py/go, LF line endings. |
| `.pre-commit-config.yaml` | gitleaks + a few hygiene hooks. Install with `pre-commit install`. |
| `SECURITY.md` | Vulnerability reporting policy. |
| `LICENSE` | MIT. |

## How sync works

The `main` branch has `scripts/sync-base.sh`. It treats the paths above as a contract: when you change any of them on `base`, the script propagates those exact files into every template branch (file copy, not merge — no conflicts). Template-specific files are never touched.

To change shared scaffolding:

1. Commit the change on `base`.
2. From `main`, run `./scripts/sync-base.sh`.

If you want a template-specific override, the path stops being base-owned (remove it from `BASE_OWNED_PATHS` in `scripts/sync-base.sh`).
