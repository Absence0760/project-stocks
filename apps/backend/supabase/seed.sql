-- Local-stack seed. Runs on `supabase db reset`.
--
-- Everything here is throwaway local data. The dev password grants access to
-- nothing outside a container on this laptop, which is why it is committed —
-- see CLAUDE.md § "Local-dev env is committed; real secrets never are."

-- Dev user: investor@test.com / testtest
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000000a1',
  'authenticated', 'authenticated', 'investor@test.com',
  extensions.crypt('testtest', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}', false,
  '', '', '', ''
);

insert into auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000a1',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"investor@test.com","email_verified":true,"phone_verified":false}',
  'email', now(), now(), now()
);

-- Reference data
insert into instruments (id, symbol, name, exchange) values
  ('00000000-0000-0000-0000-0000000000b1', 'AAPL', 'Apple Inc.',    'NASDAQ'),
  ('00000000-0000-0000-0000-0000000000b2', 'MSFT', 'Microsoft Corp.', 'NASDAQ'),
  ('00000000-0000-0000-0000-0000000000b3', 'VTI',  'Vanguard Total Stock Market ETF', 'NYSEARCA');

-- A small ledger exercising every path recompute_positions() handles:
-- multiple lots, a partial FIFO sell, a dividend, a split, and an
-- opening_balance standing in for a holding older than the export window.
insert into transactions (
  user_id, instrument_id, type, trade_date, quantity, price, amount, fees, source, external_id
) values
  -- AAPL: two buys then a partial sell.
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'buy', '2026-01-12', 10, 185.00, 1850.00, 0, 'manual', 'seed-aapl-buy-1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'buy', '2026-02-18', 5, 210.00, 1050.00, 0, 'manual', 'seed-aapl-buy-2'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'sell', '2026-05-04', 6, 225.00, 1350.00, 0, 'manual', 'seed-aapl-sell-1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'dividend', '2026-05-15', 0, null, 2.40, 0, 'manual', 'seed-aapl-div-1'),

  -- MSFT: bought once, then a 2-for-1 split.
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2',
   'buy', '2026-03-02', 8, 400.00, 3200.00, 0, 'manual', 'seed-msft-buy-1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2',
   'split', '2026-06-01', 2, null, null, 0, 'manual', 'seed-msft-split-1'),

  -- VTI: held longer than Robinhood's one-year export window, so it enters the
  -- ledger as an opening_balance with an estimated cost basis.
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3',
   'opening_balance', '2025-08-01', 25, 240.00, 6000.00, 0, 'manual', 'seed-vti-open-1');

select recompute_positions('00000000-0000-0000-0000-0000000000a1');

-- Theses and notes for the dev portfolio. AAPL carries a superseded thesis as
-- well as a live one, so the history view has something to show.
insert into theses (user_id, instrument_id, rationale, entry_conditions, exit_conditions, conviction, written_at, superseded_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'Services margin expansion is underappreciated; hardware is a floor, not the story.',
   'Add below $180.', 'Trim if services growth drops under 10% for two quarters.',
   4, '2026-01-12 09:00+00', '2026-05-04 09:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'Still holding, but the services thesis is only half working — growth decelerating.',
   null, 'Exit the remaining position if the next quarter misses again.',
   3, '2026-05-04 09:00+00', null),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2',
   'Cloud capex cycle plus a real per-seat AI attach rate. Multi-year hold.',
   'Already in.', 'Reassess if Azure growth falls below 20%.',
   5, '2026-03-02 09:00+00', null);

insert into notes (user_id, instrument_id, body, created_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'Q2 call: services growth 8.4%, second miss in a row. This is the exit condition I wrote in January.',
   '2026-05-02 16:30+00'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
   'Sold 6 shares. Kept the rest — want one more quarter before deciding.',
   '2026-05-04 09:15+00'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2',
   'Azure 31% again. Thesis intact, nothing to do.',
   '2026-06-20 11:00+00'),
  ('00000000-0000-0000-0000-0000000000a1', null,
   'Portfolio is drifting concentrated in large-cap tech. Worth a rebalance look next quarter.',
   '2026-07-01 08:00+00');
