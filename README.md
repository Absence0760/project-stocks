# project-stocks

A personal portfolio tracker and thesis journal. It reads your holdings, keeps the
reasons you bought each one, reminds you when a condition you wrote down is met,
and puts an AI research assistant over the top.

**Read + notify only. It never places a trade.**

## Why it's shaped this way

**Robinhood has no equities API.** The only official developer API is for crypto;
there is no equities key and no read-only scope for stock positions.
Reverse-engineered endpoints violate the terms of service and risk account
suspension, so this project doesn't use them. Data arrives through sanctioned
paths instead:

- **Robinhood CSV export** — works today, no approvals.
- **SnapTrade** — read-only OAuth against Robinhood's own site. Free for a single
  connection. *Planned; the adapter interface is already in place.*

That export is a **transactions** report capped at one year of history, not a
positions snapshot. So the transaction ledger is the source of truth and positions
are derived from it by FIFO replay — which also gets you cost basis and tax lots
for free. A holding older than the export window enters as an `opening_balance`
row rather than as a special case in code.

**The AI layer is a research assistant, not a stock picker.** It is never asked to
predict a price or recommend a trade. It summarises a position against *the thesis
you wrote*, flags when *your own* exit condition looks met, drafts the digest, and
notices when you've written the same worry three times. Asked to forecast, an LLM
produces fluent, confident, backward-looking narrative — which is the failure mode
this framing avoids.

## Quick start

Needs Docker, and [Supabase CLI](https://supabase.com/docs/guides/cli), Deno, pnpm,
Flutter on PATH.

```bash
pnpm install
pnpm dev:core        # local Supabase stack on 54421-54429
pnpm dev:run:web     # http://localhost:7777
```

Debug builds against a loopback host sign in automatically as the seeded user, so
the portfolio is on screen immediately. No env setup, no cloud account, no API key
— every external dependency ships a local equivalent and defaults to it.

**Seed login:** `investor@test.com` / `testtest`

```bash
pnpm dev:run:mobile  # the Flutter app
pnpm dev:down        # stop everything this project started
pnpm test            # 314 tests across four surfaces
pnpm check           # typecheck, analyze, format, drift guards
```

## Layout

```
apps/backend/    Supabase — Postgres, Auth, Deno edge functions
apps/web/        SvelteKit 5 static SPA (dev port 7777)
apps/mobile/     Flutter (Android + iOS)
infra/           Terraform — S3 + CloudFront + Route 53 + OIDC
bin/, scripts/   dev loop, structure guards
docs/STACK.md    how it works, conventions, and the gotchas worth not re-deriving
```

## Where to look

**[`docs/STACK.md`](docs/STACK.md)** is the canonical doc — stack, commands, data
model, and a list of gotchas that each cost real time to find. Read it before
changing anything.

## Ports

This machine runs more than one local Supabase stack, so this project is offset
`+100` from the defaults (`54421`–`54429`) and `pnpm dev:down` is pinned to its own
project id. `supabase start` **exits 0 even when it fails to bind a port and rolls
back** — if a start looks successful but nothing works, check `docker ps` before
believing it.

## Status

Working: the ledger and FIFO derivation, CSV import, theses and notes, quotes and
condition-based alerts, the AI digest, web and mobile clients.

Not yet: SnapTrade ingest, and a scheduler for alert delivery in production
(`deliver-alerts` is deliberately not wired to `pg_cron`, which would mean storing
a service-role key in the database). Nothing is deployed — the Terraform is
validated but has never been applied.
