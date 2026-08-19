-- Quotes, condition-based alert rules, and the job queue that delivers them.
--
-- Three things land together because they are one feature:
--
--   * `quotes` — global reference data (a price is a price), refreshed by the
--     refresh-quotes edge function from whichever provider is configured.
--   * `alert_rules` / `alert_events` / `alert_preferences` — the user-scoped half.
--     A rule describes a *condition*; an event records that the condition became
--     true. The scan that turns one into the other lives in the next migration.
--   * `jobs` — a generic Postgres-backed queue. Delivery (push, email) is work
--     that happens outside the transaction that noticed the condition, so it is
--     enqueued rather than attempted inline: a dead FCM endpoint must not roll
--     back the alert.
--
-- Nothing here fires anything. This migration is the shape; 20260819140100 is
-- the behaviour.

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function touch_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at. Used by alert_rules, alert_preferences and jobs.';

-- ---------------------------------------------------------------------------
-- Quotes — global reference data, not user-scoped
-- ---------------------------------------------------------------------------
--
-- A time series, not a latest-price cache. `pct_move` rules need to look back
-- `window_days`, and a single mutable row per instrument would make that
-- impossible to answer without a second table. Rows are small and the universe
-- is "instruments someone actually holds", so the volume is bounded by the
-- refresh cadence rather than by the market.
--
-- `source` is paired to the `QUOTE_SOURCES` TypeScript union in
-- functions/_shared/quotes/types.ts; scripts/check_constraint_unions.mjs fails
-- when only one of the two moves.

create table quotes (
  instrument_id   uuid not null references instruments (id) on delete cascade,
  as_of           timestamptz not null,
  price           numeric(20, 8) not null,
  -- Previous session's close, when the provider gives one. It is the reference a
  -- one-day `pct_move` compares against before any history has accumulated.
  previous_close  numeric(20, 8),
  source          text not null check (source in ('finnhub', 'stub', 'manual')),
  fetched_at      timestamptz not null default now(),

  primary key (instrument_id, as_of),
  constraint quotes_price_positive check (price > 0),
  constraint quotes_previous_close_positive check (previous_close is null or previous_close > 0)
);

-- No extra index: the primary key is already (instrument_id, as_of), and a
-- backward scan of it answers "latest quote for this instrument", which is the
-- only hot read.

alter table quotes enable row level security;

-- Same posture as `instruments`: readable by any signed-in user, written only by
-- the service role (the refresh function writes rows for every held instrument,
-- across every user, so it cannot be a client-scoped write).
create policy "quotes are readable by authenticated users"
  on quotes for select
  to authenticated
  using (true);

-- The latest price per instrument, for surfaces that want current value rather
-- than history. security_invoker so the reader's own privileges and policies
-- apply rather than the view owner's.
create view latest_quotes
with (security_invoker = on) as
select distinct on (q.instrument_id)
  q.instrument_id,
  q.as_of,
  q.price,
  q.previous_close,
  q.source
from quotes q
order by q.instrument_id, q.as_of desc;

-- ---------------------------------------------------------------------------
-- Alert rules
-- ---------------------------------------------------------------------------
--
-- `kind` is paired to the `ALERT_KINDS` TypeScript union in
-- functions/_shared/alerts/types.ts and drift-checked in CI. A text column plus
-- a CHECK rather than an enum: widening an enum is a separate migration step
-- with transaction restrictions, and *removing* a value is not supported at all.
-- Swapping a CHECK is a plain constraint drop-and-add.
--
-- `instrument_id` is nullable because not every kind is about one holding — a
-- portfolio-wide review reminder has no instrument. The CHECK below makes it
-- required for the kinds that genuinely need a target.
--
-- `window_days` means two things, one per kind family:
--   * `pct_move`      — how far back to look for the reference price.
--   * `thesis_review` — the review cadence; firing pushes next_review_on out by
--                       this many days (90 when null).
-- It is unused by `price_above` / `price_below`.

create table alert_rules (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  instrument_id   uuid references instruments (id) on delete cascade,
  kind            text not null check (kind in ('price_above', 'price_below', 'pct_move', 'thesis_review')),
  -- Absolute price for price_above/price_below; percent magnitude for pct_move.
  threshold       numeric(20, 8),
  window_days     integer,
  next_review_on  date,
  enabled         boolean not null default true,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint alert_rules_window_days_positive check (window_days is null or window_days > 0),
  -- Fail-closed at write time: a price rule with no instrument or no threshold
  -- can never be evaluated. The scan is fail-closed about it too (a null
  -- threshold is not a match), but a rule the user believes is armed and which
  -- silently cannot fire is worse than a rejected insert.
  constraint alert_rules_condition_needs_target check (
    kind = 'thesis_review'
    or (instrument_id is not null and threshold is not null and threshold > 0)
  ),
  constraint alert_rules_thesis_review_needs_date check (
    kind <> 'thesis_review' or next_review_on is not null
  )
);

create index alert_rules_owner_idx on alert_rules (user_id, created_at desc);

create trigger alert_rules_touch_updated_at
  before update on alert_rules
  for each row execute function touch_updated_at();

alter table alert_rules enable row level security;

create policy "users own their alert rules"
  on alert_rules for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Delivery preferences
-- ---------------------------------------------------------------------------
--
-- Off unless explicitly turned on, and a user with no row at all gets nothing.
-- The channel fan-out joins to this table, so "no preference row" and
-- "preference disabled" both resolve to no job — the fail-closed default the
-- whole feature depends on. A notification nobody asked for is a bug.

create table alert_preferences (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  push_enabled   boolean not null default false,
  email_enabled  boolean not null default false,
  -- FCM registration tokens, one per device the user has signed in on. Written
  -- by the client on login (its own row, under its own RLS policy), which is why
  -- there is no separate device registry table: a token is a per-user
  -- preference, it has no lifecycle of its own, and the set is single digits.
  push_tokens    text[] not null default '{}'::text[],
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger alert_preferences_touch_updated_at
  before update on alert_preferences
  for each row execute function touch_updated_at();

alter table alert_preferences enable row level security;

create policy "users own their alert preferences"
  on alert_preferences for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Alert events
-- ---------------------------------------------------------------------------
--
-- One row per *occurrence* — the condition became true having previously been
-- false. `context` carries the numbers that made it true so a notification can
-- be rendered (and audited) later without re-deriving them from a quote series
-- that has since moved on.
--
-- The per-channel stamps are the delivery record. NULL means "not delivered on
-- this channel", which is exactly the state a missing credential must leave
-- behind: a later, credentialed deploy re-drains the job and still delivers.

create table alert_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  alert_rule_id  uuid not null references alert_rules (id) on delete cascade,
  fired_at       timestamptz not null default now(),
  context        jsonb not null default '{}'::jsonb,
  push_sent_at   timestamptz,
  email_sent_at  timestamptz,
  created_at     timestamptz not null default now()
);

create index alert_events_timeline_idx on alert_events (user_id, fired_at desc);
create index alert_events_rule_idx on alert_events (alert_rule_id, fired_at desc);

alter table alert_events enable row level security;

-- Read-only to clients, exactly like `positions`: events are written by the
-- SECURITY DEFINER scan and stamped by the service-role delivery worker.
create policy "users read their alert events"
  on alert_events for select
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
--
-- Generic, but with exactly two tenants today: the two delivery channels.
-- `kind` is paired to the `JOB_KINDS` TypeScript union in
-- functions/_shared/alerts/types.ts and drift-checked in CI — a fan-out that
-- enqueues a kind the CHECK rejects would abort the scan's transaction, and a
-- worker that dispatches on a kind nothing enqueues is dead code.
--
-- No RLS policies and no grants: the table is service-role only. Workers go
-- through claim_job/finish_job/defer_job so the column shape can change without
-- breaking them.

create table jobs (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('alert_push', 'alert_email')),
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts      smallint not null default 0,
  max_attempts  smallint not null default 5,
  locked_by     text,
  locked_at     timestamptz,
  run_after     timestamptz not null default now(),
  last_error    text,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint jobs_attempts_non_negative check (attempts >= 0),
  constraint jobs_max_attempts_positive check (max_attempts > 0)
);

-- The claim query's exact shape: filter status='queued', order by run_after.
-- Partial, so drained jobs accumulate without bloating the worker's scan.
create index jobs_queued_idx
  on jobs (run_after, kind)
  where status = 'queued';

-- Stuck-job detection ("running for longer than any handler should take").
create index jobs_running_idx
  on jobs (locked_at)
  where status = 'running';

-- One in-flight delivery per (channel, event). The fan-out trigger is
-- AFTER INSERT on alert_events so it cannot fire twice for one event on its own,
-- but a replayed backfill or a manual re-enqueue would; this makes that a no-op
-- rather than a double notification.
create unique index jobs_alert_delivery_dedupe_idx
  on jobs (kind, ((payload ->> 'alert_event_id')))
  where status in ('queued', 'running');

create trigger jobs_touch_updated_at
  before update on jobs
  for each row execute function touch_updated_at();

alter table jobs enable row level security;

-- ---------------------------------------------------------------------------
-- Worker API
-- ---------------------------------------------------------------------------

-- Claim the next ready job. `for update skip locked` is what makes this safe
-- under concurrent workers: two callers racing each get a different row instead
-- of blocking on each other or both running the same job. Returns zero rows when
-- the queue is dry, so the caller sleeps and retries rather than erroring.
create or replace function claim_job(
  p_worker_id text,
  p_kind      text default null
)
returns table (
  id       bigint,
  kind     text,
  payload  jsonb,
  attempts smallint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_at = now(),
      locked_by = p_worker_id
  where j.id = (
    select c.id
    from jobs c
    where c.status = 'queued'
      and c.run_after <= now()
      and (p_kind is null or c.kind = p_kind)
      and c.attempts < c.max_attempts
    order by c.run_after, c.id
    limit 1
    for update skip locked
  )
  returning j.id, j.kind, j.payload, j.attempts;
end;
$$;

comment on function claim_job(text, text) is
  'Atomically claims one ready job for a worker. FOR UPDATE SKIP LOCKED; returns zero rows when the queue is dry.';

-- Terminal state for an attempt. The status is validated here as well as by the
-- table CHECK so a mis-encoded state fails at the call site with a message that
-- names the function, rather than as a constraint number on a row.
create or replace function finish_job(
  p_job_id bigint,
  p_status text,
  p_error  text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('done', 'failed') then
    raise exception 'finish_job: status must be done or failed, got %', p_status
      using errcode = '22023';
  end if;

  update jobs
  set status = p_status,
      finished_at = now(),
      locked_by = null,
      locked_at = null,
      last_error = p_error
  where id = p_job_id;
end;
$$;

comment on function finish_job(bigint, text, text) is
  'Marks a claimed job done or failed.';

-- Re-queue a transient failure with backoff. `attempts` is deliberately not
-- incremented — claim_job already did that — so max_attempts still bounds the
-- total number of tries. Once attempts reaches max_attempts the claim query
-- stops selecting the row, which is how a permanently-broken job stops.
create or replace function defer_job(
  p_job_id        bigint,
  p_delay_seconds integer,
  p_error         text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_delay_seconds < 0 then
    raise exception 'defer_job: delay_seconds must be >= 0, got %', p_delay_seconds
      using errcode = '22023';
  end if;

  update jobs
  set status = 'queued',
      run_after = now() + make_interval(secs => p_delay_seconds),
      locked_by = null,
      locked_at = null,
      last_error = p_error
  where id = p_job_id;
end;
$$;

comment on function defer_job(bigint, integer, text) is
  'Re-queues a claimed job after a delay without consuming an extra attempt.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- RLS is a filter, not a grant. A role with no table privilege is refused with
-- "permission denied for table ..." before any policy is consulted, and tables
-- created by a migration inherit privileges from nowhere. This bit the initial
-- schema once already (fixed in c546456) — so every table above is listed here
-- on purpose, including the one that gets nothing.
--
--   quotes             SELECT only  — global reference data, service role writes
--   latest_quotes      SELECT only  — the view over it
--   alert_rules        full DML     — the user's own rules
--   alert_preferences  full DML     — the user's own channel switches
--   alert_events       SELECT only  — written by the scan, stamped by the worker
--   jobs               nothing      — service-role only, via the functions below

grant select on quotes to authenticated;
grant select on latest_quotes to authenticated;
grant select, insert, update, delete on alert_rules to authenticated;
grant select, insert, update, delete on alert_preferences to authenticated;
grant select on alert_events to authenticated;

revoke all on function claim_job(text, text) from public, anon, authenticated;
revoke all on function finish_job(bigint, text, text) from public, anon, authenticated;
revoke all on function defer_job(bigint, integer, text) from public, anon, authenticated;
grant execute on function claim_job(text, text) to service_role;
grant execute on function finish_job(bigint, text, text) to service_role;
grant execute on function defer_job(bigint, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Grants — service_role
-- ---------------------------------------------------------------------------
--
-- `service_role` bypasses RLS but it does NOT bypass the grant layer, and this
-- project's config.toml leaves `auto_expose_new_tables` unset — the current
-- Supabase default, under which new entities are exposed to *none* of the Data
-- API roles. So the key an edge function holds gets "permission denied for table
-- ..." on every table nobody named here, RLS never entering into it.
--
-- Everything below is the minimum the server-side code actually touches through
-- PostgREST. The queue is deliberately absent: workers reach `jobs` only through
-- claim_job/finish_job/defer_job, and alert_events only through
-- alert_delivery()/stamp_alert_delivery(), so a compromised worker cannot rewrite
-- the queue or forge an event.

-- refresh-quotes: reads what is held, writes the prices.
grant select on positions to service_role;
grant select, insert, update on quotes to service_role;

-- The ledger tables, which had the same hole. Found while wiring the first
-- service-role reader in this repo: import-transactions has been unable to
-- resolve an instrument, open an ingest run, insert a row, or recompute the
-- projection since it was written — four 42501s, none of them reachable from a
-- unit test written against a fake store. Commit c546456 fixed exactly this class
-- of bug for `authenticated`; `service_role` was never given the same treatment
-- because nothing had exercised it yet.
grant select, insert on instruments to service_role;
grant select, insert, update on ingest_runs to service_role;
grant select, insert on transactions to service_role;
grant execute on function recompute_positions(uuid) to service_role;
