-- recompute_positions(): FIFO cost-basis derivation.
begin;
select plan(14);

-- Distinct ids so these never collide with seed.sql's dev portfolio.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-00000000f001',
  'authenticated', 'authenticated', 'fifo@test.invalid', 'x',
  now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', ''
);

insert into instruments (id, symbol, name) values
  ('00000000-0000-0000-0000-00000000f101', 'TFIFO', 'FIFO fixture'),
  ('00000000-0000-0000-0000-00000000f102', 'TSPLT', 'Split fixture'),
  ('00000000-0000-0000-0000-00000000f103', 'TOPEN', 'Opening-balance fixture'),
  ('00000000-0000-0000-0000-00000000f104', 'TOVER', 'Oversell fixture'),
  ('00000000-0000-0000-0000-00000000f105', 'TDIV',  'Dividend fixture');

-- ---------------------------------------------------------------------------
-- Two lots, one partial sell. FIFO must consume the older lot first.
-- 10 @ 100 (+5 fee) then 10 @ 200; sell 15 @ 250.
-- Consumed: 10 @ 100.50 = 1005, then 5 @ 200 = 1000 → 2005.
-- Proceeds 3750 → realized 1745. Remaining 5 @ 200.
-- ---------------------------------------------------------------------------
insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101', 'buy',  '2026-01-10', 10, 100, 1000, 5, 'manual', 'f-b1'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101', 'buy',  '2026-02-10', 10, 200, 2000, 0, 'manual', 'f-b2'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f101', 'sell', '2026-03-10', 15, 250, 3750, 0, 'manual', 'f-s1');

-- A 2-for-1 split doubles share count and halves per-share cost, leaving basis flat.
insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102', 'buy',   '2026-01-05', 8, 400, 3200, 0, 'manual', 'f-sp-b1'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f102', 'split', '2026-06-01', 2, null, null, 0, 'manual', 'f-sp-1');

-- An opening_balance stands in for a holding older than the export window.
insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f103', 'opening_balance', '2025-08-01', 25, 240, 6000, 0, 'manual', 'f-op-1');

-- Selling more than the ledger knows about: history predates the export window.
insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f104', 'buy',  '2026-01-01', 5,  50, 250,  0, 'manual', 'f-ov-b1'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f104', 'sell', '2026-02-01', 12, 60, 720,  0, 'manual', 'f-ov-s1');

-- A dividend is a cash event and must not disturb share lots.
insert into transactions (user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f105', 'buy',      '2026-01-01', 10, 20, 200, 0, 'manual', 'f-dv-b1'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000f105', 'dividend', '2026-02-01', 0, null, 7.5, 0, 'manual', 'f-dv-1');

select recompute_positions('00000000-0000-0000-0000-00000000f001');

-- --- FIFO partial sell -----------------------------------------------------
select is(
  (select quantity from positions where instrument_id = '00000000-0000-0000-0000-00000000f101'),
  5::numeric(20,8), 'FIFO: 5 shares remain after selling 15 of 20');

select is(
  (select cost_basis from positions where instrument_id = '00000000-0000-0000-0000-00000000f101'),
  1000::numeric(20,8), 'FIFO: remaining basis is the newer lot only');

select is(
  (select realized_pl from positions where instrument_id = '00000000-0000-0000-0000-00000000f101'),
  1745::numeric(20,8), 'FIFO: realized P/L consumes the oldest lot first, fees included in basis');

select is(
  (select count(*) from position_lots where instrument_id = '00000000-0000-0000-0000-00000000f101'),
  1::bigint, 'FIFO: the fully consumed lot is gone');

select is(
  (select cost_per_share from position_lots where instrument_id = '00000000-0000-0000-0000-00000000f101'),
  200::numeric(20,8), 'FIFO: the surviving lot keeps its own cost');

-- --- Splits ----------------------------------------------------------------
select is(
  (select quantity from positions where instrument_id = '00000000-0000-0000-0000-00000000f102'),
  16::numeric(20,8), 'split: 2-for-1 doubles the share count');

select is(
  (select cost_basis from positions where instrument_id = '00000000-0000-0000-0000-00000000f102'),
  3200::numeric(20,8), 'split: total cost basis is unchanged');

select is(
  (select cost_per_share from position_lots where instrument_id = '00000000-0000-0000-0000-00000000f102'),
  200::numeric(20,8), 'split: per-share cost is halved');

-- --- opening_balance -------------------------------------------------------
select is(
  (select quantity from positions where instrument_id = '00000000-0000-0000-0000-00000000f103'),
  25::numeric(20,8), 'opening_balance: establishes a holding like a buy');

select is(
  (select first_acquired_on from positions where instrument_id = '00000000-0000-0000-0000-00000000f103'),
  '2025-08-01'::date, 'opening_balance: carries its own acquisition date');

-- --- Overselling a truncated history ---------------------------------------
select is(
  (select quantity from positions where instrument_id = '00000000-0000-0000-0000-00000000f104'),
  0::numeric(20,8), 'oversell: position floors at zero rather than going negative');

select is(
  (select count(*) from position_lots where instrument_id = '00000000-0000-0000-0000-00000000f104'),
  0::bigint, 'oversell: no phantom lots survive');

-- --- Dividends -------------------------------------------------------------
select is(
  (select quantity from positions where instrument_id = '00000000-0000-0000-0000-00000000f105'),
  10::numeric(20,8), 'dividend: share count is untouched by a cash event');

-- --- Idempotency -----------------------------------------------------------
select recompute_positions('00000000-0000-0000-0000-00000000f001');

select is(
  (select sum(quantity) from positions where user_id = '00000000-0000-0000-0000-00000000f001'),
  56::numeric(20,8), 'recompute is idempotent: 5 + 16 + 25 + 0 + 10');

select * from finish();
rollback;
