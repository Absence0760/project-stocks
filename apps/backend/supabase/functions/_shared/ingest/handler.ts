/**
 * Import orchestration, written against LedgerStore so it stays testable.
 *
 * The run is recorded even when it fails: a failed `ingest_runs` row with the
 * error on it is how you find out an export changed shape, and losing that
 * because the insert threw would be the worst possible time to have no record.
 */

import { RobinhoodCsvAdapter } from "./robinhood_csv.ts";
import type { IngestAdapter, IngestSource, SkippedRow } from "./types.ts";
import type { LedgerStore } from "./store.ts";

const ADAPTERS: Partial<Record<IngestSource, () => IngestAdapter>> = {
  "robinhood-csv": () => new RobinhoodCsvAdapter(),
};

export interface ImportResult {
  ingestRunId: string;
  rowsSeen: number;
  /** Rows newly written. A re-import of an overlapping export reports 0. */
  rowsImported: number;
  /** Parsed rows already present, so not written again. */
  rowsDuplicate: number;
  skipped: SkippedRow[];
}

export class UnsupportedSourceError extends Error {
  constructor(source: string) {
    super(`no adapter for source "${source}"`);
    this.name = "UnsupportedSourceError";
  }
}

export async function handleImport(
  userId: string,
  source: IngestSource,
  content: string,
  store: LedgerStore,
): Promise<ImportResult> {
  const makeAdapter = ADAPTERS[source];
  if (!makeAdapter) throw new UnsupportedSourceError(source);

  const { transactions, skipped } = makeAdapter().parse(content);
  const rowsSeen = transactions.length + skipped.length;

  const runId = await store.startRun(userId, source);

  try {
    const instruments = await store.resolveInstruments(transactions.map((t) => t.symbol));

    const resolved: Array<Parameters<LedgerStore["insertTransactions"]>[3][number]> = [];
    const unresolved: SkippedRow[] = [];

    transactions.forEach((transaction, i) => {
      const instrumentId = instruments.get(transaction.symbol.toUpperCase());
      if (instrumentId === undefined) {
        unresolved.push({
          row: i + 1,
          reason: `could not resolve instrument "${transaction.symbol}"`,
          raw: transaction.raw,
        });
        return;
      }
      resolved.push({ ...transaction, instrumentId });
    });

    const rowsImported = await store.insertTransactions(userId, runId, source, resolved);

    // Only rebuild the projection when the ledger actually moved.
    if (rowsImported > 0) await store.recompute(userId);

    const allSkipped = [...skipped, ...unresolved];
    await store.finishRun(runId, "succeeded", {
      rowsSeen,
      rowsImported,
      rowsSkipped: allSkipped.length,
    });

    return {
      ingestRunId: runId,
      rowsSeen,
      rowsImported,
      rowsDuplicate: resolved.length - rowsImported,
      skipped: allSkipped,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort: if recording the failure also fails, surface the original.
    await store
      .finishRun(runId, "failed", { rowsSeen, rowsImported: 0, rowsSkipped: skipped.length }, message)
      .catch(() => {});
    throw error;
  }
}
