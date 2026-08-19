-- Theses and notes: the half of the product that isn't derived from the ledger.
--
-- A thesis is append-only. Superseding one writes a new row and stamps the old,
-- because the whole point is being able to read what you believed six months ago
-- next to what you believe now. Editing in place would destroy the only record
-- that makes the feature worth having.

create table theses (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  instrument_id     uuid not null references instruments (id),

  rationale         text not null,
  entry_conditions  text,
  exit_conditions   text,
  conviction        smallint check (conviction between 1 and 5),

  written_at        timestamptz not null default now(),
  superseded_at     timestamptz,
  created_at        timestamptz not null default now(),

  constraint theses_rationale_not_blank check (btrim(rationale) <> '')
);

-- At most one live thesis per instrument; history is everything with a
-- superseded_at. Enforced in the database so a partial write can't leave two.
create unique index theses_one_current_idx
  on theses (user_id, instrument_id)
  where superseded_at is null;

create index theses_history_idx
  on theses (user_id, instrument_id, written_at desc);

alter table theses enable row level security;

create policy "users own their theses"
  on theses for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Notes are the running journal. instrument_id is nullable: a note about the
-- portfolio as a whole is as useful as one about a single holding.
create table notes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  instrument_id  uuid references instruments (id),
  body           text not null,
  created_at     timestamptz not null default now(),

  constraint notes_body_not_blank check (btrim(body) <> '')
);

create index notes_timeline_idx
  on notes (user_id, created_at desc);

create index notes_instrument_idx
  on notes (user_id, instrument_id, created_at desc)
  where instrument_id is not null;

alter table notes enable row level security;

create policy "users own their notes"
  on notes for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- RLS is a filter, not a grant — see the initial schema migration.
grant select, insert, update, delete on theses to authenticated;
grant select, insert, update, delete on notes to authenticated;

-- Supersede-and-replace as one statement, so the unique index above can never be
-- tripped by a client doing it in two.
create or replace function supersede_thesis(
  p_instrument_id    uuid,
  p_rationale        text,
  p_entry_conditions text default null,
  p_exit_conditions  text default null,
  p_conviction       smallint default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_id      uuid;
begin
  if v_user_id is null then
    raise exception 'supersede_thesis() requires an authenticated caller';
  end if;

  update theses
  set superseded_at = now()
  where user_id = v_user_id
    and instrument_id = p_instrument_id
    and superseded_at is null;

  insert into theses (
    user_id, instrument_id, rationale, entry_conditions, exit_conditions, conviction
  ) values (
    v_user_id, p_instrument_id, p_rationale, p_entry_conditions, p_exit_conditions, p_conviction
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function supersede_thesis(uuid, text, text, text, smallint) is
  'Stamps the current thesis for an instrument and writes its replacement atomically.';

grant execute on function supersede_thesis(uuid, text, text, text, smallint) to authenticated;
