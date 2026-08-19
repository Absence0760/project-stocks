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
pnpm dev:db:down             # stop just the Supabase stack
pnpm dev:down                # stop everything this project started

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

- **`pnpm dev:down` is pinned to this project's Supabase id.** This box runs more
  than one local stack — `project-running` holds 54321-54327 — so a bare
  `supabase stop` resolving the id from whatever config it finds is not safe here.
  The stop keeps the database backup, so `dev:core` restores your data;
  `dev:db:reset` is the explicit way to start clean.

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
## Quotes and condition-based alerts

The ledger says what you own and the thesis journal says why. This is the part
that tells you **when to look**: prices come in, rules describe conditions over
them, and an alert fires when a condition becomes true.

```bash
pnpm dev:quotes:refresh      # price every held instrument (needs dev:core)
pnpm dev:alerts:evaluate     # run the condition scan now, not in ≤5 minutes
pnpm dev:alerts:deliver      # drain one pass of the delivery queue
```

The seed leaves the local stack with quotes for all three instruments and four
rules, two of which are already true — so a fresh `pnpm dev:db:reset` shows a
fired alert next to an armed one rather than an empty list.

### The scan is a condition, not a schedule

`evaluate_alert_rules()` runs every five minutes under pg_cron, but the tick is
not the event. The event is *the condition became true having previously been
false*, and four things make that hold:

- **Fail-closed everywhere.** A disabled rule, a null threshold, an instrument
  with no quote, a user with no `alert_preferences` row — every missing or
  switched-off input resolves to "do not fire" and "do not deliver". Nothing
  defaults to on.
- **An occurrence stamp, not a tick counter.** Firing sets
  `alert_rules.last_fired_at`; while it is set the rule is out of the firing scan
  entirely. A second pass clears it the moment the condition stops holding. A
  price that sits above its threshold for a week alerts once, and alerts again on
  the next crossing.
- **The stamp is written by the statement that selects the rows**, and the UPDATE
  re-asserts `last_fired_at is null` on its target, so two overlapping ticks
  cannot both fire one rule — the loser's row no longer matches.
- **A partial index per pass, predicate identical to the pass's WHERE.**
  `alert_rules_armed_idx` is `where enabled and last_fired_at is null`;
  `alert_rules_stamped_idx` is its complement.

Delivery is enqueued, never inline: an `AFTER INSERT` trigger on `alert_events`
writes one `jobs` row per channel the recipient has actually enabled. A dead push
endpoint must not roll back the transaction that noticed the condition.

`alert_rule_evaluations` is the view that defines the condition — one definition,
read by both passes. It is granted to `authenticated` with `security_invoker`, so
"why has my alert not fired?" is a question a client can answer about its own
rules.

### Kinds

| kind | fires when | uses |
| --- | --- | --- |
| `price_above` | latest price ≥ `threshold` | `instrument_id`, `threshold` |
| `price_below` | latest price ≤ `threshold` | `instrument_id`, `threshold` |
| `pct_move` | \|price − reference\| / reference ≥ `threshold`% | + `window_days` |
| `thesis_review` | `next_review_on` ≤ today | `next_review_on`, `window_days` |

`pct_move`'s reference is the most recent quote at least `window_days` old,
falling back to the latest quote's `previous_close` before that much history
exists. With neither, the rule does not fire — an unanswerable condition is not a
true one.

### Providers and channels — local by default

Every external service here has a local equivalent and a default that points at
it, so a fresh clone refreshes quotes and delivers alerts with no account
anywhere:

| Variable | Default | Notes |
| --- | --- | --- |
| `QUOTE_PROVIDER` | `stub` | or `finnhub` |
| `FINNHUB_API_KEY` | — | **only** required when `QUOTE_PROVIDER=finnhub` |
| `PUSH_PROVIDER` | `stub` | `fcm`, or `none` |
| `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT` | — | only when `PUSH_PROVIDER=fcm` |
| `EMAIL_PROVIDER` | `stub` | `resend`, or `none` |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | — | only when `EMAIL_PROVIDER=resend` |

The stub quote provider's prices are a pure function of (symbol, UTC day):
stable within a day, different per symbol, moving overnight. The stub senders
"deliver" by logging — deliberately including the stamp, so the dev loop
exercises the same path a deployment will.

Set the real values with `supabase secrets set` (deployed) or a gitignored
`apps/backend/supabase/functions/.env` (local) — never in a committed file.

### Endpoints

Both take the **service role key**, not a user JWT: the refresh is global (two
users holding AAPL are one price to fetch) and spends a rate-limited quota, and
the delivery worker acts on everyone's queue.

```
POST /functions/v1/refresh-quotes   → { provider, instruments, quotesWritten, failures[] }
POST /functions/v1/deliver-alerts   → { claimed, delivered, alreadyDelivered, deferred, failed, skippedChannels[] }
```

### Conventions and gotchas (quotes and alerts)

- **`service_role` bypasses RLS but not grants, and this project grants it
  nothing by default.** `config.toml` leaves `auto_expose_new_tables` unset (the
  current Supabase default), under which new tables are exposed to *no* Data API
  role — `anon`, `authenticated` and `service_role` alike. Every server-side
  table read needs an explicit `grant … to service_role` in the migration that
  creates the table. This was found the hard way: `import-transactions` had been
  unable to resolve an instrument, open a run, write a row or recompute since it
  was written — four `42501`s, none reachable from a unit test against a fake
  store. Fixed in `20260819140000`; pinned by `alerts_test.sql`.
- **A partial index whose predicate drifts from its scan does not get slower, it
  stops being used.** Postgres only picks a partial index when it can prove the
  query's qual implies the index predicate. `alerts_test.sql` plans the real scan
  with `enable_seqscan = off` and fails if the plan is not an index scan over
  `alert_rules_armed_idx` — checking the predicate text alone would not catch a
  scan that had moved.
- **`last_fired_at` is server-derived and not client-writable.** Postgres cannot
  revoke one column out of a table-level grant, so `alert_rules`' UPDATE grant is
  per-column. **A new client-writable column on `alert_rules` must be added to
  that grant list in `20260819140100`**, or writes to it fail with "permission
  denied for column".
- **`window_days` means two different things** — the `pct_move` lookback, and the
  `thesis_review` cadence. It is unused by the two price kinds.
- **Three more paired unions.** `ALERT_KINDS` ↔ `alert_rules.kind`, `JOB_KINDS` ↔
  `jobs.kind`, and `QUOTE_SOURCES` ↔ `quotes.source` all move together or
  `pnpm check:unions` fails. The `jobs.kind` pair earns its keep: a fan-out
  enqueuing a kind the CHECK rejects aborts the scan's whole transaction.
- **A missing credential must never stamp `*_sent_at`.** An unconfigured channel
  reports `configured: false` and the worker does not even *claim* its jobs — they
  sit at `attempts = 0` until a credentialed deploy drains them. Claiming and
  failing would spend the retry budget against a missing credential and turn
  "Firebase is not set up yet" into "those alerts are gone".
- **The stamp is written before the job is finished.** A crash in between leaves a
  visible `running` job that a re-drain finishes without re-sending (it sees the
  stamp); the other order would lose the delivery silently.
- **`deliver-alerts` is deliberately not scheduled from pg_cron.** Calling an edge
  function from the database means keeping a service-role key inside the database
  for `pg_net` to present, and a standing credential in a table is a real secret
  in a place this project does not put secrets. The scheduler belongs to the
  deployment (a platform cron presenting the key from the secret store); locally,
  `pnpm dev:alerts:deliver` runs a pass by hand.
- **Finnhub's free tier is 60 calls a minute, which only holds if you space
  them.** The provider walks symbols serially with a minimum interval rather than
  firing them in parallel, and the key travels in an `X-Finnhub-Token` header so
  it never lands in a URL that some log keeps.
- **A named provider with a missing key is an error, not a fallback.** Quietly
  serving stub prices to a live portfolio — and firing real alerts off them — is
  worse than a refresh that refuses to run.
- **Push tokens live on `alert_preferences.push_tokens`,** not in a device
  registry table: a token is a per-user preference with no lifecycle of its own,
  and the set is single digits.
