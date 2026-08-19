-- recompute_positions(): replay the transaction ledger into positions + FIFO lots.
--
-- Called after every ingest run (and after any manual ledger edit). Cheap enough
-- to run wholesale for a personal portfolio, and a full replay means an adapter
-- bug can be fixed and re-derived rather than migrated around.
--
-- Sign convention: `amount` is always a POSITIVE magnitude. Direction lives in
-- `type`, never in the sign — adapters normalise this on the way in.
--
-- Cost basis is FIFO. A `split` row carries its ratio in `quantity` (4 = 4-for-1)
-- and rescales the open lots in place. `dividend` / `fee` / `interest` are cash
-- events and do not touch share lots.

create or replace function recompute_positions(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t             record;
  v_lot         record;
  v_remaining   numeric(20, 8);
  v_consume     numeric(20, 8);
  v_total_cost  numeric(20, 8);
  v_proceeds    numeric(20, 8);
  v_cost_removed numeric(20, 8);
begin
  drop table if exists _fifo_lots;
  create temp table _fifo_lots (
    seq                    bigserial primary key,
    instrument_id          uuid not null,
    acquired_on            date not null,
    quantity               numeric(20, 8) not null,
    cost_per_share         numeric(20, 8) not null,
    source_transaction_id  uuid
  ) on commit drop;

  drop table if exists _realized;
  create temp table _realized (
    instrument_id  uuid primary key,
    realized_pl    numeric(20, 8) not null default 0
  ) on commit drop;

  for t in
    select *
    from transactions
    where user_id = p_user_id
    order by instrument_id, trade_date, created_at, id
  loop
    if t.type in ('buy', 'transfer_in', 'opening_balance') then
      if t.quantity > 0 then
        v_total_cost := coalesce(t.amount, t.quantity * coalesce(t.price, 0)) + t.fees;
        insert into _fifo_lots (instrument_id, acquired_on, quantity, cost_per_share, source_transaction_id)
        values (t.instrument_id, t.trade_date, t.quantity, v_total_cost / t.quantity, t.id);
      end if;

    elsif t.type in ('sell', 'transfer_out') then
      v_remaining := t.quantity;
      v_cost_removed := 0;

      -- The implicit cursor reads a stable snapshot, and lots are only ever
      -- consumed in the order they are visited, so mutating _fifo_lots inside
      -- the loop is safe.
      for v_lot in
        select * from _fifo_lots
        where instrument_id = t.instrument_id
        order by acquired_on, seq
      loop
        exit when v_remaining <= 0;

        v_consume := least(v_lot.quantity, v_remaining);
        v_cost_removed := v_cost_removed + v_consume * v_lot.cost_per_share;
        v_remaining := v_remaining - v_consume;

        if v_consume >= v_lot.quantity then
          delete from _fifo_lots where seq = v_lot.seq;
        else
          update _fifo_lots set quantity = quantity - v_consume where seq = v_lot.seq;
        end if;
      end loop;

      -- Selling more than the ledger knows about is expected when the holding
      -- predates the export window: Robinhood only serves one year of history.
      -- The shortfall is treated as zero-cost rather than letting the position go
      -- negative. An `opening_balance` row is the correct fix, not a code change.

      if t.type = 'sell' then
        v_proceeds := coalesce(t.amount, t.quantity * coalesce(t.price, 0)) - t.fees;
        insert into _realized (instrument_id, realized_pl)
        values (t.instrument_id, v_proceeds - v_cost_removed)
        on conflict (instrument_id)
          do update set realized_pl = _realized.realized_pl + excluded.realized_pl;
      end if;

    elsif t.type = 'split' then
      if t.quantity > 0 then
        update _fifo_lots
        set quantity = quantity * t.quantity,
            cost_per_share = cost_per_share / t.quantity
        where instrument_id = t.instrument_id;
      end if;

    end if;
  end loop;

  delete from position_lots where user_id = p_user_id;
  delete from positions where user_id = p_user_id;

  insert into positions (
    user_id, instrument_id, quantity, cost_basis, avg_cost,
    realized_pl, first_acquired_on, last_transaction_on, computed_at
  )
  select
    p_user_id,
    tx.instrument_id,
    coalesce(l.qty, 0),
    coalesce(l.cost, 0),
    case when coalesce(l.qty, 0) > 0 then l.cost / l.qty end,
    coalesce(r.realized_pl, 0),
    l.first_acquired,
    tx.last_trade_date,
    now()
  from (
    select instrument_id, max(trade_date) as last_trade_date
    from transactions
    where user_id = p_user_id
    group by instrument_id
  ) tx
  left join (
    select
      instrument_id,
      sum(quantity)                  as qty,
      sum(quantity * cost_per_share) as cost,
      min(acquired_on)               as first_acquired
    from _fifo_lots
    group by instrument_id
  ) l on l.instrument_id = tx.instrument_id
  left join _realized r on r.instrument_id = tx.instrument_id;

  insert into position_lots (
    user_id, instrument_id, acquired_on, quantity, cost_per_share, source_transaction_id
  )
  select p_user_id, instrument_id, acquired_on, quantity, cost_per_share, source_transaction_id
  from _fifo_lots;
end;
$$;

comment on function recompute_positions(uuid) is
  'Replays the transaction ledger into positions + position_lots using FIFO cost basis. Idempotent.';

-- Client-callable wrapper: always scoped to the caller, never to an arbitrary user.
-- SECURITY DEFINER because the caller is deliberately not granted execute on
-- recompute_positions(uuid) — that would let them pass someone else's id.
-- auth.uid() reads the request JWT claim from a session GUC, so it still resolves
-- to the calling user inside a definer function.
create or replace function recompute_my_positions()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'recompute_my_positions() requires an authenticated caller';
  end if;
  perform recompute_positions(auth.uid());
end;
$$;

revoke all on function recompute_positions(uuid) from public, anon, authenticated;
grant execute on function recompute_my_positions() to authenticated;
