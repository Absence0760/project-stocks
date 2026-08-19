-- AI digests and the consent ladder: who can read, write and erase what.
--
-- Two properties this file exists to pin:
--   * a digest is output, not input — clients read and delete, never insert;
--   * an acceptance is evidence — clients insert, never edit or erase.
-- Both are enforced by grants as much as by policies, which is why several of
-- these expect "permission denied for table" rather than an empty result.
begin;
select plan(12);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f001',
   'authenticated', 'authenticated', 'digest@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-00000000f002',
   'authenticated', 'authenticated', 'nosy@test.invalid', 'x',
   now(), now(), now(), '{"provider":"email"}', '{}', false, '', '', '', '');

-- Seeded as the owner, standing in for the service-role write the edge function
-- performs. Clients have no privilege to do this — asserted below.
insert into ai_digests (id, user_id, kind, body, context, model) values
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000f001',
   'weekly-review', 'Your AAPL exit condition looks met.',
   '{"generatedAt":"2026-08-19T12:00:00.000Z","positions":[],"liveTheses":[],"supersededTheses":[],"notes":[]}'::jsonb,
   'ollama/llama3.2'),
  ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000f002',
   'weekly-review', 'Someone else''s private digest.',
   '{}'::jsonb, 'ollama/llama3.2');

-- --- as the digest's owner --------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000f001","role":"authenticated"}',
  true);

select is(
  (select count(*) from ai_digests),
  1::bigint, 'a user sees their own digests');

select is(
  (select count(*) from ai_digests where user_id = '00000000-0000-0000-0000-00000000f002'),
  0::bigint, 'a user cannot read another user''s digest');

-- A digest is the assistant's output. A client that could write one could forge
-- provenance, so the privilege is withheld at the grant layer.
select throws_ok(
  $$insert into ai_digests (user_id, kind, body, context, model)
    values ('00000000-0000-0000-0000-00000000f001', 'weekly-review', 'forged', '{}'::jsonb, 'x')$$,
  '42501',
  'permission denied for table ai_digests',
  'a user cannot insert a digest');

select lives_ok(
  $$delete from ai_digests where id = '00000000-0000-0000-0000-00000000f101'$$,
  'a user can delete their own digest');

select is(
  (select count(*) from ai_digests),
  0::bigint, 'the deleted digest is gone');

-- --- the consent ladder -----------------------------------------------------

select lives_ok(
  $$insert into ai_disclosure_acceptances (user_id, version)
    values ('00000000-0000-0000-0000-00000000f001', 1)$$,
  'a user can record their own acceptance');

select throws_ok(
  $$insert into ai_disclosure_acceptances (user_id, version)
    values ('00000000-0000-0000-0000-00000000f002', 1)$$,
  '42501',
  'new row violates row-level security policy for table "ai_disclosure_acceptances"',
  'a user cannot record an acceptance on someone else''s behalf');

-- Acceptances are append-only evidence: no update or delete privilege exists, so
-- the record of what was agreed to cannot be rewritten after the fact.
select throws_ok(
  $$update ai_disclosure_acceptances set version = 99
    where user_id = '00000000-0000-0000-0000-00000000f001'$$,
  '42501',
  'permission denied for table ai_disclosure_acceptances',
  'a user cannot edit an acceptance');

select throws_ok(
  $$delete from ai_disclosure_acceptances
    where user_id = '00000000-0000-0000-0000-00000000f001'$$,
  '42501',
  'permission denied for table ai_disclosure_acceptances',
  'a user cannot erase an acceptance');

select throws_ok(
  $$insert into ai_disclosure_acceptances (user_id, version)
    values ('00000000-0000-0000-0000-00000000f001', 1)$$,
  '23505',
  null,
  'accepting the same version twice is a no-op, not a second record');

-- --- as an anonymous caller -------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

-- anon holds no privilege on either table, so it is refused before RLS is even
-- consulted — a stronger result than "sees zero rows".
select throws_ok(
  'select count(*) from ai_digests',
  '42501',
  'permission denied for table ai_digests',
  'an anonymous caller cannot read digests at all');

-- --- invariants owned by the schema itself ----------------------------------
reset role;

select throws_ok(
  $$insert into ai_digests (user_id, kind, body, context, model)
    values ('00000000-0000-0000-0000-00000000f001', 'weekly-review', '   ', '{}'::jsonb, 'x')$$,
  '23514',
  null,
  'a blank digest body is rejected by the schema, not stored');

select * from finish();
rollback;
