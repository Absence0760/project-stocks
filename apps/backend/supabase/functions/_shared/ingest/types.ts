/**
 * Shared ingest types.
 *
 * `INGEST_SOURCES` and `TRANSACTION_TYPES` are paired to CHECK constraints in
 * supabase/migrations/20260819120000_initial_schema.sql. The pairing is enforced
 * in CI by scripts/check_constraint_unions.mjs — add a value to both or neither.
 */

export const INGEST_SOURCES = ["robinhood-csv", "snaptrade", "manual"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export const TRANSACTION_TYPES = [
  "buy",
  "sell",
  "dividend",
  "split",
  "transfer_in",
  "transfer_out",
  "opening_balance",
  "fee",
  "interest",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * An adapter's output row, in the shape the ledger stores.
 *
 * `amount` is a POSITIVE magnitude — direction is carried by `type`, never by the
 * sign. Adapters normalise this so the FIFO replay in recompute_positions() never
 * has to guess a convention.
 */
export interface NormalizedTransaction {
  /** Uppercased ticker. Resolved to an instrument row server-side. */
  symbol: string;
  type: TransactionType;
  /** ISO `yyyy-mm-dd`. */
  tradeDate: string;
  /** Shares. For `split`, the ratio (4 = 4-for-1). */
  quantity: number;
  /** Per-share price, when the source gives one. */
  price: number | null;
  /** Total cash magnitude, when the source gives one. */
  amount: number | null;
  fees: number;
  /**
   * Stable idempotency key, unique within (user, source). Re-importing an
   * overlapping export must produce identical keys so the upsert is a no-op.
   */
  externalId: string;
  /** The original upstream row, stored for audit and re-derivation. */
  raw: Record<string, string>;
}

/** A row the adapter deliberately did not import, and why. */
export interface SkippedRow {
  /** 1-based row number in the source file, excluding the header. */
  row: number;
  reason: string;
  raw: Record<string, string>;
}

export interface ParseResult {
  transactions: NormalizedTransaction[];
  skipped: SkippedRow[];
}

export interface IngestAdapter {
  readonly source: IngestSource;
  parse(input: string): ParseResult;
}
