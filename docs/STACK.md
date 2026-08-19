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
  See "The web app" at the end of this file.
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

## The web app

`apps/web/` is a SvelteKit 5 (runes) SPA built with `adapter-static` — the same
laptop-first stack as everything else here, and the shape S3 + CloudFront wants.

```bash
pnpm dev:run:web             # start it on http://localhost:7777 (needs dev:core)
pnpm build:web               # static bundle into apps/web/build/
pnpm check:web               # svelte-kit sync + svelte-check
pnpm test:web                # vitest
```

**Static only, and client-rendered.** `src/routes/+layout.ts` sets `ssr = false`
and `prerender = false` for every route, and the adapter emits `index.html` as
the SPA fallback. This is not a preference: every page is behind Supabase auth
and the session lives in browser storage, so a server render has nothing to
render — and `adapter-static` has no server to render it on. CloudFront serves
`index.html` for any path that isn't a real object.

**The publishable key is never committed.** `bin/dev-run-web.sh` reads it out of
`supabase status` and exports it as `PUBLIC_SUPABASE_ANON_KEY` for Vite, exactly
as `dev-run-mobile.sh` does for its `--dart-define`. The committed
`apps/web/.env.development` holds only the non-sensitive URL. A committed `.env`
would put a key in git; a gitignored one would be missing on a fresh clone.

`src/lib/config/env.ts` reads `$env/dynamic/public` rather than
`$env/static/public` on purpose: the static form is a *compile error* when a
variable is absent, which would make `pnpm check:web` depend on a running
Supabase stack.

**Dev auto-login is gated on the host, not the build flag.**
`src/lib/auth/dev-auto-login.ts` is a port of `core/dev_auto_login.dart`, down to
the same host list, and `session.ts` combines it with `import.meta.env.DEV` —
the web's `kDebugMode`. Both conditions are required, so a dev build accidentally
pointed at production can never send the seeded credential to it. Keep the two
implementations in step; they exist to agree.

Two things JavaScript makes sharper than Dart did:

- **`URL().hostname` brackets an IPv6 host** (`[::1]`), where Dart's `Uri.host`
  does not. The gate strips them before comparing, or `::1` would silently stop
  matching.
- **`Number('')`, `Number(' ')`, `Number(null)` and `Number([])` are all `0`.**
  `src/lib/core/json.ts` is the port of `core/json.dart` and rejects every one of
  those before parsing, so a missing `numeric` reads as absent rather than as a
  confident zero. Nothing casts a PostgREST value directly.
- **A bare `date` column must be read as *local* midnight.** ECMAScript parses
  `'2026-01-12'` as UTC, so a browser west of Greenwich would render a January
  12th trade as the 11th. `asDateOrNull` builds date-only values from local
  components, matching `DateTime.parse`, and refuses anything not ISO-shaped.

**Revising a thesis calls the `supersede_thesis` RPC** — never an update on the
row. The form starts with a blank rationale and carries the entry/exit conditions
over, same as the mobile editor and for the same reason (see "theses are
append-only" above).

**Tests are vitest, co-located** beside the module they cover
(`json.test.ts` next to `json.ts`), so the glob in `vite.config.ts` recurses.
They cover the numeric parsing, the loopback auth gate, the row parsers and the
portfolio summary maths — the logic that is wrong silently. The Svelte components
are not unit-tested; they are thin renderers over those modules.

### Gotcha: the local edge runtime serves no functions

`supabase status` reports the stack healthy while
`POST /functions/v1/import-transactions` returns **`Function not found`** from the
edge runtime — the container comes up with no functions directory mounted at all
(`docker exec supabase_edge_runtime_project-stocks ls /home/deno/functions` →
no such file). Kong is fine; the preflight returns 200. It is the runtime behind
it that has nothing to serve, so the CSV import screen cannot complete a real
import until the stack is restarted (`pnpm dev:db:down && pnpm dev:core`) or the
functions are served explicitly with `supabase functions serve`.

Check this before assuming the import client is broken: a bare
`curl -X POST http://127.0.0.1:54421/functions/v1/import-transactions` reproduces
it without any app involved.
## The AI research assistant

A **research assistant and journal, not a stock picker.** It is never asked to
predict a price or recommend a trade, and the system prompt says so in its own
instructions rather than trusting the UI never to ask. Its four jobs:

1. Summarise a position against **the thesis the user wrote** — not against the
   model's own view of the company.
2. Flag when an **exit or entry condition the user wrote** appears to be met,
   quoted verbatim, with the note or number that raised it. Reading a note back
   is not advice; deciding what to do about it stays the user's.
3. Draft a periodic digest of what changed and what has gone unrevisited.
4. Notice repetition and drift in the notes — the same worry written three times,
   a stated plan that keeps not happening.

Everything the model asserts must be traceable to the grounding it was given; the
prompt tells it to say so when the context is silent rather than fill the gap.

### Calling it

`POST /functions/v1/ai-digest` with the caller's JWT:

```json
{ "kind": "weekly-review" }
```

`kind` is one of `weekly-review`, `thesis-check`, `note-patterns`. The response
carries the prose, the stored `digestId`, the provider-qualified `model`, token
`usage`, and **counts** of what it was grounded on (not the data itself — the
client already has that).

Notable statuses: `403 disclosure_required` (see below), `422 empty_journal`
(nothing to summarise — refused rather than handed to a model to invent),
`503 model_not_installed` (the local model needs pulling; the body names the
exact `ollama pull` command).

### Consent is checked on the server

Generating a digest sends holdings and private notes to a model, so
`ai_disclosure_acceptances` is a **versioned, fail-closed** ladder that the edge
function checks *before reading a single row* — no acceptance refuses, and an
acceptance older than `REQUIRED_DISCLOSURE_VERSION`
(`_shared/ai/disclosure.ts`) refuses too. A UI-only gate would be a suggestion;
the function is reachable with nothing but a token.

Bump `REQUIRED_DISCLOSURE_VERSION` whenever the disclosure text changes
materially (a new provider, a new class of data leaving the machine). That
re-prompts everyone, which is the intended cost. The acceptance rows are
append-only evidence: `select` + `insert` are granted, `update` and `delete` are
not.

### Providers — local by default

One env var chooses, and its absence chooses the local one:

| Variable | Default | Notes |
| --- | --- | --- |
| `AI_PROVIDER` | `ollama` | or `anthropic` |
| `AI_MODEL` | `llama3.2` / `claude-opus-5` | per provider |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible surface |
| `ANTHROPIC_API_KEY` | — | **only** required when `AI_PROVIDER=anthropic` |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | rarely needed |

A fresh clone therefore runs the assistant with no cloud account and no key. Set
the Anthropic variables through `supabase secrets set` (deployed) or a gitignored
`apps/backend/supabase/functions/.env` (local) — never in a committed file.

```bash
pnpm dev:ai:status    # is Ollama up, and is the configured model pulled?
pnpm dev:ai:pull      # ollama pull $AI_MODEL
```

### Conventions and gotchas (AI layer)

- **`127.0.0.1` means the container, not your laptop.** Functions served by the
  local Supabase edge runtime cannot reach a host Ollama on loopback. Set
  `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` for locally-served
  functions. The default stays loopback because that is right everywhere else.
- **An upstream 404 from Ollama means "not pulled", not "broken".** It is mapped
  to a message naming the exact `ollama pull` command, and surfaced as a 503.
- **Digest kinds are a paired union.** The `kind` CHECK constraint and
  `DIGEST_KINDS` in `_shared/ai/types.ts` must move together — `pnpm
  check:unions` fails if only one does.
- **Grounding is fenced.** The payload goes as its own first user turn wrapped in
  `<CONTEXT>` / `</CONTEXT>`, which the system prompt names as a data boundary,
  and those markers are stripped from user text on the way in so a note cannot
  close the block early.
- **Every context lane scopes `user_id` explicitly.** The store runs with the
  service role, which bypasses RLS — there is no policy underneath to catch a
  query that forgot the filter.
- **Test what was sent, not what came back.** The handler's tests assert the
  assembled request — system prompt, fenced grounding, task turn, consent
  ordering — against a fake store and a fake provider stream. Asserting on model
  prose pins nothing.
- **A digest is stored with its grounding.** `ai_digests.context` holds the exact
  payload the body was written from, so "why did it say that?" is answerable and
  re-opening a digest never silently re-runs the model against different data.
