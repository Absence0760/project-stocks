/**
 * Shared types for the AI research assistant.
 *
 * `DIGEST_KINDS` is paired to the `kind` CHECK constraint in
 * supabase/migrations/20260819150000_ai_digests.sql. The pairing is enforced in
 * CI by scripts/check_constraint_unions.mjs — add a kind to both or neither.
 *
 * Every kind below is a *journalling* job. None of them asks the model what a
 * price will do or whether to trade: the assistant reads back what the user
 * already wrote and what the ledger already says. See system_prompt.ts.
 */

export const DIGEST_KINDS = ["weekly-review", "thesis-check", "note-patterns"] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];

/** One row of the derived `positions` projection, as the model sees it. */
export interface PositionRow {
  symbol: string;
  quantity: string;
  costBasis: string;
  avgCost: string | null;
  realizedPl: string;
  firstAcquiredOn: string | null;
  lastTransactionOn: string | null;
}

/**
 * A thesis, live or superseded.
 *
 * Numeric-ish fields are carried as strings on purpose: Postgres `numeric`
 * arrives as a string over PostgREST, and rounding it through a float on the way
 * to a prompt would be a silent data change for no benefit.
 */
export interface ThesisRow {
  symbol: string;
  rationale: string;
  entryConditions: string | null;
  exitConditions: string | null;
  conviction: number | null;
  writtenAt: string;
  supersededAt: string | null;
}

/** A journal entry. `symbol` is null for a note about the portfolio as a whole. */
export interface NoteRow {
  symbol: string | null;
  body: string;
  createdAt: string;
}

/**
 * Everything the assistant is grounded on for one run.
 *
 * This is what gets stored in `ai_digests.context`, so a digest can be reviewed
 * later against the portfolio as it actually stood, rather than as it stands now.
 */
export interface GroundingPayload {
  generatedAt: string;
  positions: PositionRow[];
  liveTheses: ThesisRow[];
  supersededTheses: ThesisRow[];
  notes: NoteRow[];
}
