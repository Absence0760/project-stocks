-- The condition scan: rules in, events out.
--
-- This is a *condition* scan, not a schedule. pg_cron supplies the tick, but the
-- tick is not the event — the event is "the condition became true having
-- previously been false". Four properties make that true, and each one is load
-- bearing:
--
--   1. Fail-closed. A disabled rule, a rule with no threshold, an instrument
--      with no quote, a user with no delivery preference — every missing or
--      switched-off input resolves to "do not fire", never to a default.
--   2. Idempotent per occurrence, via a stamp on the rule row. Firing sets
--      `last_fired_at`; while it is set the rule is out of the firing scan
--      entirely. A separate re-arm pass clears the stamp the moment the
--      condition stops holding. So a price that sits above its threshold for a
--      week alerts once, not once per tick, and alerts again on the next
--      crossing.
--   3. The stamp is written by the same statement that selects the rows, so two
--      overlapping ticks cannot both fire the same rule: the loser's row no
--      longer satisfies the UPDATE's `last_fired_at is null` re-check.
--   4. A partial index whose predicate is character-for-character the scan's
--      predicate, so the sweep is an index scan over the armed set rather than a
--      seq scan over every rule anyone has ever written.
--
-- Delivery is not attempted here. The AFTER INSERT trigger at the bottom fans an
-- event out to one `jobs` row per *enabled* channel; the worker sends. A dead
-- push endpoint must not roll back the transaction that noticed the condition.

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- The occurrence stamp
-- ---------------------------------------------------------------------------
--
-- NULL means armed. Non-null means "already fired for the occurrence that is
-- still in progress" — cleared by the re-arm pass once the condition goes false.

alter table alert_rules add column last_fired_at timestamptz;

comment on column alert_rules.last_fired_at is
  'Occurrence stamp. NULL = armed. Set when the rule fires, cleared by evaluate_alert_rules() once the condition stops holding. Server-derived: not client-writable.';

-- Derived state, so clients do not get to write it — the same posture as
-- `positions`. Postgres cannot revoke one column out of a table-level grant, so
-- the table-level UPDATE from 20260819140000 is dropped and re-granted per
-- column.
--
-- MAINTENANCE: a new client-writable column on alert_rules must be added to this
-- list, or writes to it fail with "permission denied for column". alerts_test.sql
-- pins the carve-out.
revoke update on alert_rules from authenticated;
grant update (instrument_id, kind, threshold, window_days, next_review_on, enabled, note)
  on alert_rules to authenticated;

-- ---------------------------------------------------------------------------
-- The condition, written once
-- ---------------------------------------------------------------------------
--
-- Both passes of the scan need "is this rule's condition true right now", and a
-- condition expressed twice is a condition that will disagree with itself. It
-- lives here, in a plain view: no aggregate, no DISTINCT, no window, no LIMIT,
-- so the planner flattens it into the caller and pushes the caller's quals on
-- `enabled` / `last_fired_at` down onto the alert_rules scan — which is what
-- lets the partial indexes below be used at all.
--
-- security_invoker so a client reading it sees their own rules under their own
-- RLS, and the SECURITY DEFINER scan below sees everything because it runs as
-- the table owner.
--
-- The reference price for `pct_move` is the most recent quote at least
-- `window_days` old, falling back to the latest quote's `previous_close` when no
-- history that old exists yet. If neither is available the rule does not fire —
-- an unanswerable condition is not a true one.

create view alert_rule_evaluations
with (security_invoker = on) as
select
  r.id,
  r.user_id,
  r.instrument_id,
  r.kind,
  r.threshold,
  r.window_days,
  r.next_review_on,
  r.enabled,
  r.last_fired_at,
  q.as_of          as quote_as_of,
  q.price          as quote_price,
  q.previous_close as quote_previous_close,
  ref.price        as reference_price,
  coalesce(
    case r.kind
      when 'price_above' then
        q.price is not null and r.threshold is not null and q.price >= r.threshold
      when 'price_below' then
        q.price is not null and r.threshold is not null and q.price <= r.threshold
      when 'pct_move' then
        q.price is not null and r.threshold is not null
        and ref.price is not null and ref.price > 0
        and abs(q.price - ref.price) / ref.price * 100 >= r.threshold
      when 'thesis_review' then
        r.next_review_on is not null and r.next_review_on <= current_date
    end,
    false
  ) as condition_met,
  jsonb_strip_nulls(jsonb_build_object(
    'kind', r.kind,
    'instrument_id', r.instrument_id,
    'symbol', i.symbol,
    'threshold', r.threshold,
    'window_days', r.window_days,
    'price', q.price,
    'quote_as_of', q.as_of,
    'reference_price', ref.price,
    'pct_change', case
      when q.price is not null and ref.price is not null and ref.price > 0
      then round((q.price - ref.price) / ref.price * 100, 4)
    end,
    'next_review_on', r.next_review_on,
    'note', r.note
  )) as context
from alert_rules r
left join instruments i
  on i.id = r.instrument_id
-- Latest quote for the rule's instrument. A backward scan of the quotes PK.
left join lateral (
  select lq.as_of, lq.price, lq.previous_close
  from quotes lq
  where lq.instrument_id = r.instrument_id
  order by lq.as_of desc
  limit 1
) q on true
-- Oldest-enough quote inside the rule's window, for pct_move.
left join lateral (
  select pq.price
  from quotes pq
  where pq.instrument_id = r.instrument_id
    and pq.as_of <= now() - make_interval(days => coalesce(r.window_days, 1))
  order by pq.as_of desc
  limit 1
) prior on true
cross join lateral (
  select coalesce(prior.price, q.previous_close) as price
) ref;

comment on view alert_rule_evaluations is
  'Every alert rule with its current condition state and the context an event would carry. The single definition of "has this condition come true"; evaluate_alert_rules() reads it twice, once per pass.';

-- ---------------------------------------------------------------------------
-- The indexes the scan runs on
-- ---------------------------------------------------------------------------
--
-- Each predicate is exactly the WHERE clause of the pass that uses it. That is
-- not a stylistic preference: Postgres only uses a partial index when it can
-- prove the query's qual implies the index predicate, so a predicate that drifts
-- from its scan does not degrade the plan, it silently stops being used and the
-- sweep goes back to reading every rule in the table.
--
-- Together they cover the enabled set, but each pass touches only its own half.

create index alert_rules_armed_idx
  on alert_rules (id)
  where enabled and last_fired_at is null;

create index alert_rules_stamped_idx
  on alert_rules (id)
  where enabled and last_fired_at is not null;

-- ---------------------------------------------------------------------------
-- The scan
-- ---------------------------------------------------------------------------

create or replace function evaluate_alert_rules()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fired integer;
begin
  -- Pass 1 — re-arm. A stamped rule whose condition has gone false is ready for
  -- its next occurrence. Runs first only for readability; within one transaction
  -- both passes see the same snapshot and the same rule cannot satisfy both.
  --
  -- WHERE matches alert_rules_stamped_idx exactly.
  update alert_rules r
  set last_fired_at = null
  from (
    select e.id
    from alert_rule_evaluations e
    where e.enabled
      and e.last_fired_at is not null
      and not e.condition_met
  ) cleared
  where r.id = cleared.id
    and r.enabled
    and r.last_fired_at is not null;

  -- Pass 2 — fire. The stamp is written by the same statement that selects the
  -- rows, and the UPDATE re-asserts `last_fired_at is null` on the target, so a
  -- concurrent tick that already stamped the row fails the re-check and this one
  -- writes no event: one event per occurrence even if the schedule overlaps.
  --
  -- A fired thesis_review also walks its review date forward, which is what
  -- takes its condition false again so pass 1 can re-arm it. Price rules re-arm
  -- when the price moves back across the threshold.
  --
  -- `candidates`' WHERE matches alert_rules_armed_idx exactly.
  with candidates as (
    select e.id, e.user_id, e.context
    from alert_rule_evaluations e
    where e.enabled
      and e.last_fired_at is null
      and e.condition_met
  ),
  stamped as (
    update alert_rules r
    set last_fired_at = now(),
        next_review_on = case
          when r.kind = 'thesis_review'
            then current_date + coalesce(r.window_days, 90)
          else r.next_review_on
        end
    from candidates c
    where r.id = c.id
      and r.enabled
      and r.last_fired_at is null
    returning r.id, c.user_id, c.context
  )
  insert into alert_events (user_id, alert_rule_id, context)
  select s.user_id, s.id, s.context
  from stamped s;

  get diagnostics v_fired = row_count;
  return v_fired;
end;
$$;

comment on function evaluate_alert_rules() is
  'Condition scan. Re-arms rules whose condition has gone false, then fires and stamps rules whose condition has just become true. Returns the number of alert_events written. Idempotent per occurrence, not per tick.';

revoke all on function evaluate_alert_rules() from public, anon, authenticated;
grant execute on function evaluate_alert_rules() to service_role;

-- Readable by clients: "why has my alert not fired" is a real question, and with
-- security_invoker + the alert_rules policy the answer is scoped to the asker.
grant select on alert_rule_evaluations to authenticated;

-- ---------------------------------------------------------------------------
-- Channel fan-out
-- ---------------------------------------------------------------------------
--
-- One job per *enabled* channel. Fail-closed twice over: a user with no
-- alert_preferences row matches no rows at all (the join drops them), and a
-- channel switched off matches no rows either. Neither produces a job, and no
-- job means no send — there is no code path where an unconfigured channel
-- delivers anything.
--
-- The payload carries ids only. The worker resolves the event and the recipient
-- itself, so a queued job cannot deliver to an address the user has since
-- changed, and no contact detail sits in a queue row waiting to go stale.

create or replace function enqueue_alert_delivery_jobs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into jobs (kind, payload)
  select
    ch.job_kind,
    jsonb_build_object(
      'alert_event_id', new.id::text,
      'user_id', new.user_id::text,
      'channel', ch.channel
    )
  from alert_preferences p
  cross join lateral (
    values
      ('push'::text,  'alert_push'::text,  p.push_enabled),
      ('email'::text, 'alert_email'::text, p.email_enabled)
  ) as ch (channel, job_kind, enabled)
  where p.user_id = new.user_id
    and coalesce(ch.enabled, false)
  on conflict do nothing;

  return new;
end;
$$;

comment on function enqueue_alert_delivery_jobs() is
  'AFTER INSERT on alert_events: enqueues one delivery job per channel the recipient has enabled. No preference row and no enabled channel both mean no job.';

revoke all on function enqueue_alert_delivery_jobs() from public, anon, authenticated;

create trigger alert_events_enqueue_delivery
  after insert on alert_events
  for each row execute function enqueue_alert_delivery_jobs();

-- ---------------------------------------------------------------------------
-- Worker-facing delivery API
-- ---------------------------------------------------------------------------
--
-- The queue payload carries ids only, so the worker needs one call to turn an
-- event id into everything a send needs. It has to be a function rather than a
-- PostgREST select because the recipient's address lives in `auth.users`, which
-- is not part of the exposed schema.
--
-- Both stamps are returned so the worker can recognise an event it has already
-- delivered on this channel and finish the job without sending again — the
-- re-drain case after a crash between the stamp and finish_job.

create or replace function alert_delivery(p_alert_event_id uuid)
returns table (
  alert_event_id uuid,
  user_id        uuid,
  fired_at       timestamptz,
  context        jsonb,
  push_sent_at   timestamptz,
  email_sent_at  timestamptz,
  email          text,
  push_tokens    text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id,
    e.user_id,
    e.fired_at,
    e.context,
    e.push_sent_at,
    e.email_sent_at,
    u.email::text,
    coalesce(p.push_tokens, '{}'::text[])
  from alert_events e
  join auth.users u on u.id = e.user_id
  left join alert_preferences p on p.user_id = e.user_id
  where e.id = p_alert_event_id;
$$;

comment on function alert_delivery(uuid) is
  'Everything a delivery worker needs for one alert event: the context, the current per-channel stamps, and the recipient''s address and device tokens.';

-- The only writer of the delivery stamps. A stamp means "this channel is done
-- with this event" — it is written after a send succeeds and never before, so an
-- unconfigured or failing channel leaves it NULL and the event stays deliverable
-- for a later, credentialed deploy.
create or replace function stamp_alert_delivery(
  p_alert_event_id uuid,
  p_channel        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_channel not in ('push', 'email') then
    raise exception 'stamp_alert_delivery: unknown channel %', p_channel
      using errcode = '22023';
  end if;

  update alert_events
  set push_sent_at  = case when p_channel = 'push'  then now() else push_sent_at  end,
      email_sent_at = case when p_channel = 'email' then now() else email_sent_at end
  where id = p_alert_event_id;
end;
$$;

comment on function stamp_alert_delivery(uuid, text) is
  'Records that one channel delivered one alert event. Called only after a successful send.';

revoke all on function alert_delivery(uuid) from public, anon, authenticated;
revoke all on function stamp_alert_delivery(uuid, text) from public, anon, authenticated;
grant execute on function alert_delivery(uuid) to service_role;
grant execute on function stamp_alert_delivery(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------
--
-- Five minutes: quotes refresh no faster than that, so a tighter schedule would
-- re-evaluate unchanged data. The scan is idempotent, so the cadence only
-- controls latency, never whether an alert is delivered twice.
--
-- cron.schedule is upsert-by-name on Supabase's pg_cron, so re-running this
-- migration re-points the existing job rather than creating a second one.

select cron.schedule(
  'evaluate-alert-rules',
  '*/5 * * * *',
  $$select public.evaluate_alert_rules()$$
);
