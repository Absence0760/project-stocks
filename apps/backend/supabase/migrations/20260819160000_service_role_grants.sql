-- Grant service_role what the edge functions actually need.
--
-- Every edge function talks to PostgREST with the service-role key, and
-- service_role had NO privilege on ANY table in this schema. `auto_expose_new_tables`
-- is unset in config.toml — the new cloud default, and the field is deprecated and
-- removed on 2026-10-30 — so nothing is auto-exposed and the legacy default
-- privileges that used to paper over this no longer apply. Explicit grants are the
-- fix; re-enabling the deprecated flag would only defer the problem.
--
-- This is the same mistake as the earlier authenticated-role one, a role over:
-- RLS is a filter, not a grant. service_role additionally bypasses RLS, which makes
-- the missing grant the *only* thing standing between a function and the data — so
-- these stay least-privilege rather than a blanket `grant all`.
--
-- Verified broken before this migration:
--   has_table_privilege('service_role','transactions','insert')  -> f
--   has_function_privilege('service_role','recompute_positions') -> f
-- which means import-transactions would have failed at three separate points.

-- Ingest resolves tickers and creates instrument rows; clients deliberately cannot.
grant select, insert on instruments to service_role;

-- Insert for the upsert, select because `Prefer: return=representation` reads back
-- the rows that were actually written — that count is how a re-import reports 0.
grant select, insert on transactions to service_role;

-- Runs are opened, then stamped with counts or an error on completion.
grant select, insert, update on ingest_runs to service_role;

-- Read-only: the projection is written by recompute_positions(), which is SECURITY
-- DEFINER and writes as the owner. No function needs to write these directly.
grant select on positions to service_role;
grant select on position_lots to service_role;

-- The AI context builder reads the journal. It never writes it.
grant select on theses to service_role;
grant select on notes to service_role;

-- `revoke all ... from public` in 20260819120100 removed the default PUBLIC execute,
-- which took service_role's with it. Clients still reach this only through
-- recompute_my_positions(), which scopes to auth.uid(); granting the raw function to
-- service_role does not widen client access.
grant execute on function recompute_positions(uuid) to service_role;
