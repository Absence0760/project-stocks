-- Alerts: the condition scan, its idempotency, the channel fan-out, and the
-- boundaries around all three.
--
-- The scan's contract is "once per occurrence, not once per tick", so almost
-- every assertion here runs the scan twice and checks the second run did
-- nothing. Wall-clock time never enters into it: within one transaction now() is
-- frozen, so a second call is a genuine second tick against identical data —
-- which is exactly the case a schedule-driven implementation gets wrong.
begin;
select plan(42);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000a001',
   'authenticated', 'authenticated', 'alerts-alice@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000a002',
   'authenticated', 'authenticated', 'alerts-bob@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', '');

insert into instruments (id, symbol, name) values
  ('00000000-0000-0000-0000-00000000a101', 'TALRT', 'Alert fixture'),
  ('00000000-0000-0000-0000-00000000a102', 'TNOQT', 'Unquoted fixture');

-- TALRT trades at 100, having closed at 99. TNOQT has no quote at all.
insert into quotes (instrument_id, as_of, price, previous_close, source) values
  ('00000000-0000-0000-0000-00000000a101', now() - interval '30 minutes', 100, 99, 'stub');

-- Alice wants push and not email. Bob has no preferences row at all — the
-- fail-closed case that must produce no delivery of any kind.
insert into alert_preferences (user_id, push_enabled, email_enabled)
values ('00000000-0000-0000-0000-00000000a001', true, false);

insert into alert_rules (id, user_id, instrument_id, kind, threshold, enabled, note) values
  -- Condition true right now.
  ('00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-00000000a001',
   '00000000-0000-0000-0000-00000000a101', 'price_below', 150, true, 'alice below'),
  -- Condition false right now.
  ('00000000-0000-0000-0000-00000000a202', '00000000-0000-0000-0000-00000000a001',
   '00000000-0000-0000-0000-00000000a101', 'price_above', 150, true, 'alice above'),
  -- Condition true, but switched off.
  ('00000000-0000-0000-0000-00000000a203', '00000000-0000-0000-0000-00000000a001',
   '00000000-0000-0000-0000-00000000a101', 'price_below', 150, false, 'alice disabled'),
  -- Condition can never be evaluated: the instrument has no quote.
  ('00000000-0000-0000-0000-00000000a204', '00000000-0000-0000-0000-00000000a001',
   '00000000-0000-0000-0000-00000000a102', 'price_below', 150, true, 'alice unquoted'),
  -- Bob's, to prove the scan is not per-user and the fan-out is.
  ('00000000-0000-0000-0000-00000000a205', '00000000-0000-0000-0000-00000000a002',
   '00000000-0000-0000-0000-00000000a101', 'price_below', 150, true, 'bob below');

-- ---------------------------------------------------------------------------
-- Once per occurrence, not once per tick
-- ---------------------------------------------------------------------------

select is(
  evaluate_alert_rules(), 2,
  'the first tick fires every rule whose condition is true');

select is(
  evaluate_alert_rules(), 0,
  'the next tick fires nothing: the occurrence has not changed');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a201'),
  1::bigint, 'exactly one event exists for the rule that fired');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a203'),
  0::bigint, 'a disabled rule never fires, however true its condition');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a204'),
  0::bigint, 'a rule whose instrument has no quote never fires');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a202'),
  0::bigint, 'a rule whose condition is false never fires');

select is(
  (select context ->> 'price' from alert_events
   where alert_rule_id = '00000000-0000-0000-0000-00000000a201'),
  '100.00000000', 'the event carries the price that made the condition true');

-- ---------------------------------------------------------------------------
-- Channel fan-out — one job per enabled channel, none otherwise
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from jobs where kind = 'alert_push'
     and payload ->> 'user_id' = '00000000-0000-0000-0000-00000000a001'),
  1::bigint, 'the enabled channel gets exactly one delivery job');

select is(
  (select count(*) from jobs where kind = 'alert_email'),
  0::bigint, 'a disabled channel gets no job at all');

select is(
  (select count(*) from jobs where payload ->> 'user_id' = '00000000-0000-0000-0000-00000000a002'),
  0::bigint, 'a user with no preferences row gets nothing: fail-closed, not defaulted');

select is(
  (select push_sent_at from alert_events
   where alert_rule_id = '00000000-0000-0000-0000-00000000a201'),
  null, 'enqueuing is not delivering: the channel stamp stays null until a send');

-- ---------------------------------------------------------------------------
-- Re-arming: a new occurrence fires again
-- ---------------------------------------------------------------------------

-- Price crosses up: the price_above rule's occurrence begins, and both
-- price_below rules stop matching and re-arm.
insert into quotes (instrument_id, as_of, price, previous_close, source)
values ('00000000-0000-0000-0000-00000000a101', now() - interval '20 minutes', 200, 100, 'stub');

select is(
  evaluate_alert_rules(), 1,
  'a rule whose condition has just become true fires on the next tick');

select is(
  (select last_fired_at is null from alert_rules
   where id = '00000000-0000-0000-0000-00000000a201'),
  true, 'a rule whose condition has gone false is re-armed');

-- ...and back down: the same rule fires a second time, for a second occurrence.
insert into quotes (instrument_id, as_of, price, previous_close, source)
values ('00000000-0000-0000-0000-00000000a101', now() - interval '10 minutes', 100, 200, 'stub');

select is(
  evaluate_alert_rules(), 2,
  'the re-armed rules fire again on the next crossing');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a201'),
  2::bigint, 'two crossings produced two events, not two hundred ticks'' worth');

-- ---------------------------------------------------------------------------
-- thesis_review: the occurrence is a date, and firing moves it
-- ---------------------------------------------------------------------------

insert into alert_rules (id, user_id, kind, next_review_on, window_days, enabled, note)
values ('00000000-0000-0000-0000-00000000a206', '00000000-0000-0000-0000-00000000a001',
        'thesis_review', current_date - 1, 30, true, 'quarterly re-read');

select is(
  evaluate_alert_rules(), 1,
  'a review whose date has passed fires');

select is(
  (select count(*) from alert_events where alert_rule_id = '00000000-0000-0000-0000-00000000a206'),
  1::bigint, 'and records exactly one review event');

select is(
  (select next_review_on from alert_rules where id = '00000000-0000-0000-0000-00000000a206'),
  current_date + 30, 'firing walks the review date forward by the cadence');

select is(
  evaluate_alert_rules(), 0,
  'the review does not fire again now its date is in the future');

select is(
  (select last_fired_at is null from alert_rules
   where id = '00000000-0000-0000-0000-00000000a206'),
  true, 'and it is re-armed, ready for the next review date');

-- ---------------------------------------------------------------------------
-- pct_move falls back to the previous close before history exists
-- ---------------------------------------------------------------------------

insert into alert_rules (id, user_id, instrument_id, kind, threshold, window_days, enabled)
values ('00000000-0000-0000-0000-00000000a207', '00000000-0000-0000-0000-00000000a001',
        '00000000-0000-0000-0000-00000000a101', 'pct_move', 20, 1, true);

select is(
  evaluate_alert_rules(), 1,
  'pct_move fires against previous_close when no quote is old enough to be the reference');

select is(
  (select context ->> 'reference_price' from alert_events
   where alert_rule_id = '00000000-0000-0000-0000-00000000a207'),
  '200.00000000', 'and records which reference it measured against');

-- ---------------------------------------------------------------------------
-- The scan predicate and its index cannot drift apart
-- ---------------------------------------------------------------------------

select is(
  (select pg_get_expr(indpred, indrelid) from pg_index
   where indexrelid = 'alert_rules_armed_idx'::regclass),
  '(enabled AND (last_fired_at IS NULL))',
  'the armed index predicate is still the scan predicate');

create function pg_temp.scan_plan() returns text language plpgsql as $$
declare
  plan_text text := '';
  line record;
begin
  for line in
    execute 'explain (costs off) select e.id, e.user_id, e.context '
         || 'from alert_rule_evaluations e '
         || 'where e.enabled and e.last_fired_at is null and e.condition_met'
  loop
    plan_text := plan_text || line."QUERY PLAN" || E'\n';
  end loop;
  return plan_text;
end;
$$;

set local enable_seqscan = off;

-- The real guard: Postgres only uses a partial index when the query's qual
-- implies the index predicate, so a predicate that drifts from its scan does not
-- degrade the plan — it silently stops being used.
select matches(
  pg_temp.scan_plan(), 'alert_rules_armed_idx',
  'the firing scan plans as an index scan over the armed set');

set local enable_seqscan = on;

-- ---------------------------------------------------------------------------
-- Write-time fail-closed
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into alert_rules (user_id, instrument_id, kind, enabled)
    values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a101', 'price_above', true)$$,
  '23514',
  null,
  'a price rule with no threshold is rejected rather than silently never firing');

select throws_ok(
  $$insert into alert_rules (user_id, kind, enabled)
    values ('00000000-0000-0000-0000-00000000a001', 'thesis_review', true)$$,
  '23514',
  null,
  'a review rule with no review date is rejected');

-- ---------------------------------------------------------------------------
-- The worker API
-- ---------------------------------------------------------------------------

create temp table claimed (id bigint) on commit drop;
insert into claimed select id from claim_job('worker-a', 'alert_push');
insert into claimed select id from claim_job('worker-b', 'alert_push');

select is(
  (select count(distinct id) from claimed),
  2::bigint, 'two claims take two different jobs, never the same one twice');

select is(
  (select count(*) from jobs where status = 'running' and locked_by in ('worker-a', 'worker-b')),
  2::bigint, 'a claimed job is marked running against the worker holding it');

select is(
  (select count(*) from claim_job('worker-a', 'alert_email')),
  0::bigint, 'a dry queue returns no rows rather than erroring');

select throws_ok(
  $$select finish_job(1, 'maybe')$$,
  '22023',
  null,
  'finish_job refuses a status that is not a terminal state');

-- A transient failure goes back on the queue without spending an extra attempt:
-- claim_job already counted this try, and double-counting would halve the
-- retry budget.
select defer_job((select min(id) from claimed), 60, 'transport unavailable');

select is(
  (select array[status, attempts::text, (run_after > now())::text] from jobs
   where id = (select min(id) from claimed)),
  array['queued', '1', 'true'],
  'defer_job re-queues with backoff and leaves the attempt count alone');

-- ---------------------------------------------------------------------------
-- The grants the server side runs on
-- ---------------------------------------------------------------------------
--
-- service_role bypasses RLS but not the grant layer, and this project's
-- config.toml exposes new entities to nobody. Every one of these was missing
-- until the first service-role reader was wired up, which is why they are pinned
-- rather than assumed: nothing written against a fake store can catch a 42501.

select ok(
  has_table_privilege('service_role', 'positions', 'select')
  and has_table_privilege('service_role', 'quotes', 'insert')
  and has_table_privilege('service_role', 'quotes', 'update'),
  'the quote refresh can read holdings and write prices');

select ok(
  has_table_privilege('service_role', 'instruments', 'insert')
  and has_table_privilege('service_role', 'ingest_runs', 'insert')
  and has_table_privilege('service_role', 'ingest_runs', 'update')
  and has_table_privilege('service_role', 'transactions', 'insert')
  and has_function_privilege('service_role', 'recompute_positions(uuid)', 'execute'),
  'the import path can resolve instruments, record a run, write the ledger and recompute');

select ok(
  not has_table_privilege('service_role', 'jobs', 'select')
  and not has_table_privilege('service_role', 'alert_events', 'insert'),
  'but reaches the queue and the event log only through their functions');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}',
  true);

select is(
  (select count(*) from alert_rules where user_id = '00000000-0000-0000-0000-00000000a002'),
  0::bigint, 'a user cannot see another user''s alert rules');

select is(
  (select count(*) from alert_events where user_id = '00000000-0000-0000-0000-00000000a002'),
  0::bigint, 'a user cannot see another user''s alert events');

select throws_ok(
  $$insert into alert_rules (user_id, instrument_id, kind, threshold)
    values ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000a101', 'price_above', 10)$$,
  '42501',
  'new row violates row-level security policy for table "alert_rules"',
  'a user cannot write an alert rule owned by someone else');

-- alert_events is written by the SECURITY DEFINER scan; no client write policy
-- exists, so a direct insert is refused.
select throws_ok(
  $$insert into alert_events (user_id, alert_rule_id)
    values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a201')$$,
  '42501',
  null,
  'a user cannot forge their own alert events');

-- The occurrence stamp is server-derived state, carved out of the table-level
-- UPDATE grant. Clearing it by hand would re-fire an alert that already fired.
select throws_ok(
  $$update alert_rules set last_fired_at = null where id = '00000000-0000-0000-0000-00000000a201'$$,
  '42501',
  null,
  'a user cannot write the occurrence stamp');

select lives_ok(
  $$update alert_rules set enabled = false, note = 'muted'
    where id = '00000000-0000-0000-0000-00000000a201'$$,
  'but can still edit the columns a rule is actually made of');

-- The queue is service-role only: refused at the grant layer, before RLS.
select throws_ok(
  'select count(*) from jobs',
  '42501',
  'permission denied for table jobs',
  'a signed-in user cannot read the delivery queue');

select throws_ok(
  $$select * from claim_job('impostor')$$,
  '42501',
  null,
  'a signed-in user cannot claim delivery jobs');

reset role;
select * from finish();
rollback;
