-- Row-level security: the ledger is per-user, the projection is read-only.
begin;
select plan(8);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000e001',
   'authenticated', 'authenticated', 'alice@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000e002',
   'authenticated', 'authenticated', 'bob@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', '');

insert into instruments (id, symbol, name)
values ('00000000-0000-0000-0000-00000000e101', 'TRLS', 'RLS fixture');

insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', 'buy', '2026-01-01', 1, 10, 10, 0, 'manual', 'rls-a1'),
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', 'buy', '2026-01-02', 1, 10, 10, 0, 'manual', 'rls-a2'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000e101', 'buy', '2026-01-03', 1, 10, 10, 0, 'manual', 'rls-b1');

select recompute_positions('00000000-0000-0000-0000-00000000e001');

-- --- as Alice --------------------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000e001","role":"authenticated"}',
  true);

select is(
  (select count(*) from transactions where instrument_id = '00000000-0000-0000-0000-00000000e101'),
  2::bigint, 'a user sees their own ledger rows');

select is(
  (select count(*) from transactions where user_id = '00000000-0000-0000-0000-00000000e002'),
  0::bigint, 'a user cannot see another user''s ledger rows');

select throws_ok(
  $$insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id)
    values ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000e101', 'buy', '2026-02-01', 1, 10, 10, 0, 'manual', 'rls-forged')$$,
  '42501',
  'new row violates row-level security policy for table "transactions"',
  'a user cannot write a ledger row owned by someone else');

select is(
  (select count(*) from positions where user_id = '00000000-0000-0000-0000-00000000e001'),
  1::bigint, 'a user reads their own derived positions');

-- The projection is written only by recompute_positions(), which is SECURITY
-- DEFINER; no client-facing write policy exists, so any direct write is denied.
select throws_ok(
  $$insert into positions (user_id, instrument_id, quantity, cost_basis)
    values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', 999, 999)$$,
  '42501',
  null,
  'a user cannot write the derived positions table directly');

select throws_ok(
  $$insert into position_lots (user_id, instrument_id, acquired_on, quantity, cost_per_share)
    values ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000e101', '2026-01-01', 1, 1)$$,
  '42501',
  null,
  'a user cannot write the derived lots table directly');

select is(
  (select count(*) from instruments where id = '00000000-0000-0000-0000-00000000e101'),
  1::bigint, 'reference instruments are readable by any signed-in user');

-- --- as an anonymous caller ------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

-- anon holds no privilege on the ledger at all, so it is refused at the grant
-- layer before RLS is even consulted — a stronger result than "sees zero rows".
select throws_ok(
  'select count(*) from transactions',
  '42501',
  'permission denied for table transactions',
  'an anonymous caller cannot read the ledger at all');

reset role;
select * from finish();
rollback;
