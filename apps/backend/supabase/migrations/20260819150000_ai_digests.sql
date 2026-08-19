-- The AI research assistant's storage: what it produced, and whether the user
-- ever agreed to it running at all.
--
-- Framing, because it constrains the schema: this layer is a *research assistant
-- and journal*, not a stock picker. It summarises against the user's own written
-- thesis, flags when an exit condition the user wrote appears to be met, drafts a
-- periodic digest, and notices repetition in the notes. It is never asked to
-- predict a price or recommend a trade, so nothing here stores a signal, a target
-- or a recommendation — only prose the user asked for, plus the exact grounding
-- it was written from.

-- ---------------------------------------------------------------------------
-- Consent ladder
-- ---------------------------------------------------------------------------
--
-- Running a digest ships the user's holdings and private notes to a model. That
-- is precisely the case a disclosure exists for, so the *server* checks it — a
-- UI-only gate is a suggestion, not a control.
--
-- Versioned and fail-closed: the required version is a constant in
-- functions/_shared/ai/disclosure.ts (REQUIRED_DISCLOSURE_VERSION). Bumping it
-- when the disclosure text materially changes (a new provider, a new class of
-- data leaving the box) invalidates every older acceptance and re-prompts
-- everyone, because accepting the old text is not consent to the new one.
--
-- Rows are append-only evidence: the primary key keeps one row per accepted
-- version, and no update or delete policy exists, so the history of what was
-- agreed to and when survives. Accepting v2 does not erase having accepted v1.
create table ai_disclosure_acceptances (
  user_id      uuid not null references auth.users (id) on delete cascade,
  version      integer not null check (version > 0),
  accepted_at  timestamptz not null default now(),

  primary key (user_id, version)
);

alter table ai_disclosure_acceptances enable row level security;

create policy "users read their disclosure acceptances"
  on ai_disclosure_acceptances for select
  to authenticated
  using (auth.uid() = user_id);

-- Insert only. Recording an acceptance is the user's act; withdrawing is not an
-- edit to that record but the absence of a newer one, and letting a client
-- rewrite the evidence that consent was given defeats the point of keeping it.
create policy "users record their own acceptance"
  on ai_disclosure_acceptances for insert
  to authenticated
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Generated digests
-- ---------------------------------------------------------------------------
--
-- Persisted rather than streamed-and-forgotten, so a response can be reviewed
-- later against the exact grounding it was written from, and so re-opening a
-- digest never silently re-runs the model against different data.
--
-- `kind` is paired to DIGEST_KINDS in functions/_shared/ai/types.ts; the pair is
-- drift-checked in CI by scripts/check_constraint_unions.mjs. Add a kind to both
-- or neither.
create table ai_digests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('weekly-review', 'thesis-check', 'note-patterns')),

  -- The assistant's prose, exactly as returned.
  body        text not null,

  -- The grounding payload the body was written from: positions, live theses,
  -- superseded theses, recent notes. Kept so "why did it say that?" is
  -- answerable without guessing at what the portfolio looked like that day.
  context     jsonb not null,

  -- Provider-qualified model id ("ollama/llama3.2", "anthropic/claude-opus-5").
  -- Qualified rather than bare because the same model name behind a different
  -- provider is a different result, and reproducing a digest needs both halves.
  model       text not null,

  created_at  timestamptz not null default now(),

  constraint ai_digests_body_not_blank check (btrim(body) <> '')
);

create index ai_digests_timeline_idx
  on ai_digests (user_id, created_at desc);

create index ai_digests_kind_idx
  on ai_digests (user_id, kind, created_at desc);

alter table ai_digests enable row level security;

create policy "users read their digests"
  on ai_digests for select
  to authenticated
  using (auth.uid() = user_id);

-- Deletable but not writable: a digest is the assistant's output, so a client
-- inserting one would be forging provenance. Deleting your own is a data-subject
-- right. The ai-digest function writes with the service role, which bypasses RLS
-- entirely, so no insert policy is needed for the real writer.
create policy "users delete their digests"
  on ai_digests for delete
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- RLS is a filter, not a grant — a role with no table privilege is refused with
-- "permission denied for table ..." before any policy is consulted, and a table
-- created by a migration inherits privileges from nowhere. Same note as the
-- initial schema migration; this repo has been bitten by it once already.
--
-- The grants are deliberately narrower than the usual CRUD set and match the
-- policies above exactly: no insert/update on digests, no update/delete on
-- acceptances.

grant select, delete on ai_digests to authenticated;
grant select, insert on ai_disclosure_acceptances to authenticated;

-- The ai-digest function reads the consent row and writes the digest with the
-- service role. `service_role` bypasses RLS but still needs the privilege, and
-- this project leaves `auto_expose_new_tables` unset in config.toml — whose own
-- documentation says new entities are then NOT auto-exposed to `anon`,
-- `authenticated` *or* `service_role`. Explicit here rather than assumed: if the
-- default grants do still exist these are a harmless no-op, and if they do not,
-- their absence is a `permission denied for table ai_digests` at the first
-- digest.
grant select, insert on ai_digests to service_role;
grant select on ai_disclosure_acceptances to service_role;

comment on table ai_digests is
  'AI research-assistant output, stored with the grounding it was generated from.';
comment on table ai_disclosure_acceptances is
  'Append-only record of which version of the AI disclosure a user accepted.';
