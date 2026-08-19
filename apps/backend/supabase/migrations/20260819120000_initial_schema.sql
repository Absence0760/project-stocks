-- Initial schema: instruments, the transaction ledger, and its derived positions.
--
-- Design note: Robinhood's CSV export is a *transactions* report, not a positions
-- snapshot, and it only reaches back one year. So `transactions` is the source of
-- truth and `positions` / `position_lots` are a projection recomputed by
-- `recompute_positions()` (next migration). Holdings older than the export window
-- are represented by an `opening_balance` transaction, which behaves exactly like
-- a buy.

-- ---------------------------------------------------------------------------
-- Reference data (global, not user-scoped — a ticker is a ticker)
-- ---------------------------------------------------------------------------

create table instruments (
  id          uuid primary key default gen_random_uuid(),
  symbol      text not null,
  name        text,
  exchange    text,
  created_at  timestamptz not null default now()
);

-- Symbols are matched case-insensitively on ingest; store them uppercased.
create unique index instruments_symbol_key on instruments (upper(symbol));

alter table instruments enable row level security;

-- Reference data is readable by any signed-in user; only the service role writes it
-- (ingest resolves/creates instruments server-side).
create policy "instruments are readable by authenticated users"
  on instruments for select
  to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Ingest provenance
-- ---------------------------------------------------------------------------

-- Adapter identifiers. This CHECK is paired to the TypeScript `IngestSource`
-- union in apps/backend/supabase/functions/_shared/ingest/types.ts and the pair is
-- drift-checked in CI by scripts/check_constraint_unions.mjs. Add to both or neither.
create table ingest_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  source         text not null check (source in ('robinhood-csv', 'snaptrade', 'manual')),
  status         text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_seen      integer not null default 0,
  rows_imported  integer not null default 0,
  rows_skipped   integer not null default 0,
  error          text
);

create index ingest_runs_user_started_idx on ingest_runs (user_id, started_at desc);

alter table ingest_runs enable row level security;

create policy "users own their ingest runs"
  on ingest_runs for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table transactions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  instrument_id  uuid not null references instruments (id),
  type           text not null check (type in (
                   'buy', 'sell', 'dividend', 'split',
                   'transfer_in', 'transfer_out', 'opening_balance',
                   'fee', 'interest'
                 )),
  trade_date     date not null,

  -- Shares for share-moving rows. For `split`, this is the ratio (4 = 4-for-1).
  -- Fractional shares are real on Robinhood, hence the scale.
  quantity       numeric(20, 8) not null default 0,

  -- Per-share price, and the total cash amount of the row. Either may be null
  -- for rows where it doesn't apply (a split has neither).
  price          numeric(20, 8),
  amount         numeric(20, 8),
  fees           numeric(20, 8) not null default 0,

  source         text not null check (source in ('robinhood-csv', 'snaptrade', 'manual')),

  -- Idempotency key. Adapters synthesise a stable value when the upstream row
  -- carries no id of its own, so re-importing an overlapping export is a no-op.
  external_id    text not null,

  -- The original upstream row, kept for audit and for re-deriving if an adapter
  -- bug is found later.
  raw            jsonb,

  ingest_run_id  uuid references ingest_runs (id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint transactions_source_external_id_key unique (user_id, source, external_id),
  constraint transactions_quantity_non_negative check (quantity >= 0),
  constraint transactions_fees_non_negative check (fees >= 0)
);

-- The replay order used by recompute_positions(). Keeping created_at in the index
-- makes the FIFO walk a plain ordered scan.
create index transactions_replay_idx
  on transactions (user_id, instrument_id, trade_date, created_at);

alter table transactions enable row level security;

create policy "users own their transactions"
  on transactions for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Derived projection — never written by clients
-- ---------------------------------------------------------------------------

create table positions (
  user_id              uuid not null references auth.users (id) on delete cascade,
  instrument_id        uuid not null references instruments (id),
  quantity             numeric(20, 8) not null,
  cost_basis           numeric(20, 8) not null,
  avg_cost             numeric(20, 8),
  realized_pl          numeric(20, 8) not null default 0,
  first_acquired_on    date,
  last_transaction_on  date,
  computed_at          timestamptz not null default now(),

  primary key (user_id, instrument_id)
);

alter table positions enable row level security;

-- Read-only to clients. recompute_positions() is SECURITY DEFINER and writes as
-- the owner, so no INSERT/UPDATE/DELETE policy is granted here on purpose.
create policy "users read their positions"
  on positions for select
  to authenticated
  using (auth.uid() = user_id);

-- Open FIFO tax lots. Falls out of the same walk that produces `positions`.
create table position_lots (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users (id) on delete cascade,
  instrument_id          uuid not null references instruments (id),
  acquired_on            date not null,
  quantity               numeric(20, 8) not null,
  cost_per_share         numeric(20, 8) not null,
  source_transaction_id  uuid references transactions (id) on delete set null,
  computed_at            timestamptz not null default now(),

  constraint position_lots_quantity_positive check (quantity > 0)
);

create index position_lots_owner_idx
  on position_lots (user_id, instrument_id, acquired_on);

alter table position_lots enable row level security;

create policy "users read their position lots"
  on position_lots for select
  to authenticated
  using (auth.uid() = user_id);
