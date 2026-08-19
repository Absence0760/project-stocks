# .claude/ — Claude Code tooling

These agents and commands were derived from a real working web app (SvelteKit + Hono + DynamoDB + CMS + payment-redirect shape) and **lightly generalized** with placeholder names: `<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`, `<EMAIL_SERVICE>_API_KEY`, etc.

**They will not be 100% accurate for your project out of the box.** Each new project should re-read these and replace placeholder examples with the actual services / routes / file paths in use. Treat them as templates of *structure and rigor*, not as fully-portable boilerplate.

## What's here

### Agents (`agents/`)

- **`code-reviewer.md`** — invoked at PR / pre-commit time to review the diff against the project's documented rules.
- **`doc-hygiene-checker.md`** — checks that code changes update docs and tests in the same change.
- **`test-gap-checker.md`** — finds modules / routes without test coverage.
- **`ui-polisher.md`** — applies typography / layout polish to frontend surfaces. Heavily SvelteKit-flavoured; adapt for other frontend frameworks.
- **`repo-security-auditor.md`** — read-only security auditor. The "trust boundaries" section needs rewriting per project — the example boundaries (frontend ↔ user, backend ↔ caller, backend ↔ <CMS>, backend ↔ <payment-processor>) reflect one specific stack shape, not a universal map.
- **`compliance-auditor.md`** — read-only privacy / legal / accessibility auditor. Backs the GDPR, cookie-consent, data-export, account-deletion, third-party-data-flows, and accessibility audit commands. Knows enough about GDPR / ePrivacy / CCPA / WCAG to flag the obvious gaps; the operator still owns the final policy / legal call.
- **`migration-coordinator.md`** — DB schema-change coordinator. Applies a migration locally, verifies RLS coverage on tenant tables, surfaces manual type-sync edits, proposes smoke-test additions. Pairs with `/safe-migration`.
- **`persona-*.md`** — bug-hunting personas. Each adopts a real-world point of view (`new-user`, `power-user`, `admin`, `international-user`, `accessibility-user`, `integrator`, `adversary`, `data-subject`) and walks the app the way that person would, finding logic / UX / domain bugs a code review misses. Read-only; each writes a living report to `reviews/<persona>.md` (git-ignored). Stack-agnostic — they discover the app first. Protocol + how to add project-specific domain personas (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller, …): `personas/README.md`. Run via `/persona`.

### Commands (`commands/`)

- **`check.md`** — run typecheck + tests + format + lint and report.
- **`safe-edit.md`** — workflow for edits to security-sensitive or load-bearing files.
- **`safe-migration.md`** — DB-schema-change workflow with `migration-coordinator` in the loop.
- **`polish-ui.md`** — orchestrates the `ui-polisher` agent against a target surface.
- **`persona.md`** — runs one, several, or all of the `persona-*` bug-hunting auditors in parallel and consolidates their reports.
- **`release-readiness.md`** — go/no-go checklist before tagging a release.
- **`audit/`** — directory of focused audits. Each command delegates to `repo-security-auditor` (security surfaces) or `compliance-auditor` (privacy / legal / a11y surfaces):
  - Security: `secrets.md`, `infra.md`, `deps.md`, `xss.md`, `cost-controls.md`, `auth.md` (route gating + tenant-context discipline)
  - Privacy / compliance: `gdpr.md`, `cookie-consent.md`, `data-export-completeness.md`, `account-deletion-completeness.md`, `third-party-data-flows.md`
  - Quality: `accessibility.md`
  - `all.md` runs them all in sequence; `README.md` is the index

## Adapting these for a new project

1. Rewrite the trust-boundary map in `agents/repo-security-auditor.md` to match your stack's actual third-party integrations.
2. Update route tables in `audit/cost-controls.md` and `audit/infra.md` to match your `backend/src/routes/*` and `infra/*.tf`.
3. Replace the `<placeholder>` tokens (`<payment-processor>`, `<CMS>`, `<email-service>`, `<aws-region>`) with real service names so the agents stop emitting them in reports.
4. Add stack-specific audits not covered here (Postgres RLS? Edge functions? Mobile-twin parity? GDPR / app-store privacy? — extend `audit/` with the checks that matter for your trust surface).
5. Remove audits that don't apply (e.g. `cost-controls.md` doesn't apply to a static-only site with no Lambda / no third-party APIs).
6. Add domain personas. The generic `persona-*` panel applies to any app; most projects also deserve personas tied to their domain (an invoicing app's approver/CFO/accountant, a marketplace's buyer/seller/dispute, a healthcare app's patient/clinician). Copy the closest generic persona and follow `personas/README.md` § "Domain packs".
