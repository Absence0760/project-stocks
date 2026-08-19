-- service_role must hold exactly the privileges the edge functions need.
--
-- This class of bug has bitten twice: RLS policies without table grants for
-- `authenticated`, then no grants at all for `service_role`. Both were invisible
-- until something tried to run. These assertions are the tripwire — a new table
-- reachable from an edge function fails here rather than in production.
begin;
select plan(14);

-- --- what the ingest path needs -------------------------------------------
select ok(has_table_privilege('service_role', 'instruments', 'select'),
  'service_role reads instruments');
select ok(has_table_privilege('service_role', 'instruments', 'insert'),
  'service_role creates instruments — clients deliberately cannot');
select ok(has_table_privilege('service_role', 'transactions', 'insert'),
  'service_role writes ledger rows');
select ok(has_table_privilege('service_role', 'transactions', 'select'),
  'service_role reads back written rows (Prefer: return=representation)');
select ok(has_table_privilege('service_role', 'ingest_runs', 'insert'),
  'service_role opens an ingest run');
select ok(has_table_privilege('service_role', 'ingest_runs', 'update'),
  'service_role stamps an ingest run with its counts');
select ok(has_function_privilege('service_role', 'recompute_positions(uuid)', 'execute'),
  'service_role recomputes the projection after an import');

-- --- what the AI context builder needs ------------------------------------
select ok(has_table_privilege('service_role', 'positions', 'select'),
  'service_role reads positions for grounding');
select ok(has_table_privilege('service_role', 'theses', 'select'),
  'service_role reads theses for grounding');
select ok(has_table_privilege('service_role', 'notes', 'select'),
  'service_role reads notes for grounding');

-- --- least privilege: the derived tables stay derived ----------------------
-- recompute_positions() is SECURITY DEFINER and writes as the owner, so nothing
-- needs direct write access. A grant here would let a bug desync the projection
-- from the ledger it is supposed to be derived from.
select ok(not has_table_privilege('service_role', 'positions', 'insert'),
  'service_role cannot write positions directly');
select ok(not has_table_privilege('service_role', 'position_lots', 'insert'),
  'service_role cannot write position lots directly');

-- Nothing in the product deletes ledger history.
select ok(not has_table_privilege('service_role', 'transactions', 'delete'),
  'service_role cannot delete ledger rows');

-- anon must never reach the ledger at any privilege level.
select ok(not has_table_privilege('anon', 'transactions', 'select'),
  'anon holds no privilege on the ledger');

select * from finish();
rollback;
