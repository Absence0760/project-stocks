# Stack — project-stocks

Personal portfolio tracker and thesis journal. Reads holdings, keeps notes and
theses against each position, fires condition-based reminders, and layers an AI
research assistant over the lot. **Read + notify only — it never places trades.**

Production secrets live SOPS + AWS-KMS-encrypted in the private `infra-secrets`
repo (one subdir per project), never here.

## Stack

- **apps/backend/** — Supabase: Postgres 17, Auth, Deno Edge Functions. Local
  stack on ports `54421`–`54429`.
- **apps/mobile/** — Flutter (Android + iOS), Dart workspace member.
- **apps/web/** — SvelteKit 5 static (`adapter-static`). Dev port `7777`.
  *Not yet scaffolded.*
- **infra/** — Terraform: S3 + CloudFront + Route 53 + ACM + GitHub OIDC.
  *Not yet scaffolded.*

pnpm workspace for JS; Deno for edge functions; a native Dart `workspace:` for
Flutter. Node `>=22`, Flutter 3.44+.

**No melos.** With a single Dart package it orchestrates nothing `flutter test`
doesn't already do. Reintroduce it when the web companion adds shared packages —
that's also when `packages/{core_models,ui_kit,api_client}` should be extracted,
not before (`CLAUDE.md` § no preemptive abstraction).

> **Ports are offset +100 from the Supabase defaults on purpose.** `project-running`
> also runs a local Supabase stack and holds `54321`–`54327`. Two stacks cannot
> share ports — `supabase start` fails with `Bind for 0.0.0.0:54322 failed` and,
> unhelpfully, **still exits 0**. If a start "succeeds" but nothing works, check
> `docker ps` before believing it.

## Commands (run from repo root)

```bash
pnpm setup                   # one-time bootstrap (needs Docker running)
pnpm dev:core                # start the local Supabase stack
pnpm dev:db:reset            # re-apply migrations + seed
pnpm dev:db:status           # ports and service health
pnpm dev:db:down             # stop the stack

pnpm setup:mobile            # resolve the Dart workspace
pnpm dev:run:mobile          # run the Flutter app against the local stack

pnpm test                    # everything
pnpm test:backend:unit       # deno tests (edge functions, ingest adapters)
pnpm test:backend:db         # pgTAP (schema, FIFO derivation, RLS)
pnpm test:mobile             # flutter test
pnpm check                   # typecheck edge functions + analyze/format Dart
pnpm gen:types               # regenerate database.types.ts from the live schema
```

## First-time setup (after cloning)

Local dev needs **no env setup** — the committed `.env.development` files point at
the local stack, and the seed creates a working user.

1. `pnpm install`
2. `pnpm setup` (needs Docker)
3. `pnpm dev:core`

**Seed login:** `investor@test.com` / `testtest`

Personal overrides go in a gitignored `<workspace>/.env.development.local`, which
loads last and wins — never edit the committed `.env.development`.

### Deploy bootstrap (AWS — only when you're ready to ship)

`project-stocks` is a **new** in-org account, so the standard script applies (unlike
`project-running`, which was invited in and lacks `OrganizationAccountAccessRole`).

```bash
~/github/templates/scripts/new-project-account.sh project-stocks
cd ~/github/infra-secrets && ./bin/sops-init.sh --project project-stocks --region <region>
```

Take `create_subdomain = true` for `stocks.jaredhoward.com`, delegated from the
`jaredhoward.com` parent zone — the delegation stage runs as the `dns-parent` profile.

## Data model

The **transaction ledger is the source of truth.** `positions` and `position_lots`
are a projection, rebuilt from scratch by `recompute_positions(user_id)` after every
ingest. A full replay means an adapter bug can be fixed and re-derived rather than
migrated around.

This shape is forced by the source data: Robinhood's CSV export is a *transactions*
report, not a positions snapshot, and it only reaches back one year.

## Importing

`POST /functions/v1/import-transactions` with the caller's JWT:

```json
{ "source": "robinhood-csv", "content": "<the CSV text>" }
```

Returns `{ ingestRunId, rowsSeen, rowsImported, rowsDuplicate, skipped[] }`. Every
run is recorded in `ingest_runs` — including failed ones, with the error attached,
which is how you find out an export changed shape.

Re-importing an overlapping export is a genuine no-op: rows are upserted on
`(user_id, source, external_id)` with `resolution=ignore-duplicates`, and
`recompute_positions()` only runs when something was actually written.

Adding an adapter means implementing `IngestAdapter`, registering it in
`_shared/ingest/handler.ts`, and adding its id to **both** `INGEST_SOURCES` and the
`source` CHECK constraint — `pnpm check:unions` fails if only one moves.

Get a CSV from Robinhood → Account → Reports and Statements. Generation is
asynchronous; expect a couple of hours.

## The app

`dev:run:mobile` reads the Supabase publishable key out of `supabase status` and
passes it as a `--dart-define`. It is never written to a file or committed: a
bundled `.env` asset would have to be gitignored (and then missing from the asset
path) or committed (and then a key in git).

Debug builds pointed at a **loopback host** sign in as the seeded user
automatically. The gate is on the host, not just `kDebugMode` — a debug build
pointed at production must never send a hardcoded credential.

## Conventions and gotchas

- **`amount` is always a positive magnitude.** Direction lives in `type`, never in
  the sign. Adapters normalise on the way in so the FIFO replay never guesses.
- **A `split` row carries its ratio in `quantity`** (4 = 4-for-1) and rescales open
  lots in place, leaving total cost basis unchanged.
- **Holdings older than the export window need an `opening_balance` row.** Selling
  more than the ledger knows about is expected, not a bug — `recompute_positions()`
  floors the position at zero and treats the shortfall as zero-cost. The fix is a
  ledger row, not a code change.
- **RLS is a filter, not a grant.** Every client-reachable table needs both a policy
  *and* a `grant`; a missing grant fails with `permission denied` before any policy
  is consulted. Migrations do not inherit privileges from anywhere.
- **Migrations must be named `YYYYMMDDhhmmss_description.sql`.** Supabase parses the
  version from the `YYYYMMDD` prefix only, so `project-running`'s `YYYYMMDD_NNN_`
  style breaks `supabase db reset` on the second migration of any given day.
- **Adapter ids are a paired union.** The `source` CHECK constraint and the
  `INGEST_SOURCES` TypeScript union must move together.
- **Columns resolve by alias list, never by position** — broker exports get
  reordered and renamed between revisions.
- **Theses are append-only.** Revising writes a new row and stamps the old via
  `supersede_thesis()`. The editor deliberately starts from a blank rationale:
  pre-filling invites editing history rather than recording a change of mind.
- **`setState` takes a block body, not an arrow**, when assigning a Future.
  `setState(() => _future = load())` returns the Future from the callback and
  trips a framework assertion at runtime.
- **Postgres `numeric` can arrive as a String.** Every numeric read goes through
  `core/json.dart` rather than casting, or a list builder throws at runtime.
- **Dart workspace `dependency_overrides` belong in the root `pubspec.yaml`**, not
  on a member — a per-member override is a workspace-wide claim, and two members
  declaring the same one collide.

## What not to do

- Don't reach for an unofficial Robinhood API. There is no equities API; the only
  official one is for crypto. Reverse-engineered endpoints violate the ToS and risk
  account suspension. Ingest is CSV today, SnapTrade (sanctioned OAuth, read-only)
  next.
- Don't let clients write `positions` or `position_lots` — they are derived. Change
  the ledger and recompute.
- Don't guess a split ratio. A wrong ratio silently corrupts cost basis; skip the
  row and report it instead.
- Don't add a second JS package manager. pnpm only — `project-running`'s dual
  pnpm/npm lockfiles drift, to the point its audit workflow has to OR two exit codes.
- Don't parse dates with `new Date("3/14/2026")`. It resolves against the runtime's
  timezone and can shift a trade by a day.
- Don't edit a thesis in place. Supersede it — the history is the product.
- Don't let Deno resolve npm packages here. It writes a `workspaces` field into the
  root `package.json` whenever it sees `pnpm-workspace.yaml` nearby, which is the
  dual-workspace drift this repo exists to avoid.
