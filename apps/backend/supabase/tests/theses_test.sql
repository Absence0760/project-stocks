-- Theses: append-only history with exactly one live row per instrument.
begin;
select plan(9);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d001',
   'authenticated', 'authenticated', 'thesis@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000d002',
   'authenticated', 'authenticated', 'other@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', '');

insert into instruments (id, symbol, name)
values ('00000000-0000-0000-0000-00000000d101', 'TTHES', 'Thesis fixture');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000d001","role":"authenticated"}',
  true);

-- --- writing a first thesis ------------------------------------------------
select lives_ok(
  $$select supersede_thesis('00000000-0000-0000-0000-00000000d101'::uuid, 'Margins recovering', 'below 180', 'two guidance misses', 4::smallint)$$,
  'a first thesis can be written');

select is(
  (select count(*) from theses where superseded_at is null),
  1::bigint, 'exactly one live thesis exists');

select is(
  (select conviction from theses where superseded_at is null),
  4::smallint, 'conviction round-trips');

-- --- superseding -----------------------------------------------------------
select lives_ok(
  $$select supersede_thesis('00000000-0000-0000-0000-00000000d101'::uuid, 'Thesis broken, margins reversed', null, 'exit on next bounce', 2::smallint)$$,
  'a replacement thesis can be written');

select is(
  (select count(*) from theses where superseded_at is null),
  1::bigint, 'still exactly one live thesis after superseding');

select is(
  (select count(*) from theses),
  2::bigint, 'the superseded thesis is kept, not overwritten');

select is(
  (select rationale from theses where superseded_at is null),
  'Thesis broken, margins reversed', 'the live thesis is the newest one');

-- The old thesis is the whole point of the feature: it must survive verbatim.
select is(
  (select rationale from theses where superseded_at is not null),
  'Margins recovering', 'history preserves what you believed before');

-- --- the one-live-thesis invariant is enforced by the database --------------
select throws_ok(
  $$insert into theses (user_id, instrument_id, rationale)
    values ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d101', 'sneaking in a second live thesis')$$,
  '23505',
  null,
  'a second live thesis for one instrument is rejected');

reset role;
select * from finish();
rollback;
