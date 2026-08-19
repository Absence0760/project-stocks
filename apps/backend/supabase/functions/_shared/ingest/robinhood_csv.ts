/**
 * Robinhood CSV adapter.
 *
 * Source: Robinhood → Account → Reports and Statements → generate a CSV report.
 * Known limits of that export, which shape everything below:
 *   - reports are generated asynchronously (~2h, occasionally up to 24h)
 *   - only ~1 year of history is offered
 *   - crypto, futures and spending-account activity are excluded
 *   - it is a TRANSACTIONS report, not a positions snapshot
 *
 * Consequently a holding older than the export window arrives with sells but no
 * matching buys. That is expected: the fix is an `opening_balance` transaction,
 * not a code change. recompute_positions() treats the shortfall as zero-cost
 * rather than letting the position go negative.
 *
 * Columns are resolved by alias list, never by position — Robinhood has revised
 * its export headers before.
 */

import { dropBlankRows, parseCsv } from "./csv.ts";
import { cell, makeColumnResolver } from "./columns.ts";
import { parseDate, parseMoney, parseQuantity, parseSplitRatio } from "./values.ts";
import type {
  IngestAdapter,
  NormalizedTransaction,
  ParseResult,
  SkippedRow,
  TransactionType,
} from "./types.ts";

const DATE_ALIASES = ["activity date", "date", "activity_date", "trade date"];
const SYMBOL_ALIASES = ["instrument", "symbol", "ticker"];
const DESCRIPTION_ALIASES = ["description", "memo"];
const TRANS_CODE_ALIASES = ["trans code", "transaction code", "code", "type", "action"];
const QUANTITY_ALIASES = ["quantity", "shares", "qty"];
const PRICE_ALIASES = ["price", "share price", "unit price"];
const AMOUNT_ALIASES = ["amount", "net amount", "value"];

/**
 * Robinhood transaction codes → our ledger types.
 *
 * Codes deliberately absent are handled as skips below rather than guessed at:
 * options legs (BTO/STO/BTC/STC/OEXP/OASGN) have no share-lot meaning in v1, and
 * pure-cash movements (ACH/RTP) carry no instrument.
 */
const CODE_MAP: Record<string, TransactionType> = {
  buy: "buy",
  sell: "sell",
  cdiv: "dividend",
  mdiv: "dividend",
  spl: "split",
  rec: "transfer_in",
  int: "interest",
  mint: "interest",
  gold: "fee",
  dfee: "fee",
  afee: "fee",
  dtax: "fee",
};

const CASH_ONLY_CODES = new Set(["ach", "rtp", "dcnv", "wire"]);
const OPTIONS_CODES = new Set(["bto", "sto", "btc", "stc", "oexp", "oasgn", "oc", "oe"]);

export class RobinhoodCsvAdapter implements IngestAdapter {
  readonly source = "robinhood-csv" as const;

  parse(input: string): ParseResult {
    const rows = dropBlankRows(parseCsv(input));
    const transactions: NormalizedTransaction[] = [];
    const skipped: SkippedRow[] = [];

    if (rows.length === 0) {
      return { transactions, skipped };
    }

    const header = rows[0];
    const col = makeColumnResolver(header);

    const idx = {
      date: col(DATE_ALIASES),
      symbol: col(SYMBOL_ALIASES),
      description: col(DESCRIPTION_ALIASES),
      code: col(TRANS_CODE_ALIASES),
      quantity: col(QUANTITY_ALIASES),
      price: col(PRICE_ALIASES),
      amount: col(AMOUNT_ALIASES),
    };

    // Without a date and a transaction code there is nothing to import — report
    // that once against the file rather than once per row.
    if (idx.date === null || idx.code === null) {
      return {
        transactions,
        skipped: [{
          row: 0,
          reason:
            "unrecognised file: no activity-date or transaction-code column found",
          raw: rowToObject(header, header),
        }],
      };
    }

    // Counts occurrences of an otherwise-identical row so two genuine same-day
    // fills at the same price stay distinct. Only the COUNT matters for
    // stability: a re-export that gains a row simply grows the group and mints
    // one new key, leaving existing keys untouched.
    const occurrences = new Map<string, number>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const raw = rowToObject(header, row);
      const rowNumber = i;

      const rawCode = cell(row, idx.code).toLowerCase();
      const tradeDate = parseDate(cell(row, idx.date));
      const symbol = cell(row, idx.symbol).toUpperCase();
      const description = cell(row, idx.description);

      if (tradeDate === null) {
        skipped.push({ row: rowNumber, reason: `unparseable date "${cell(row, idx.date)}"`, raw });
        continue;
      }
      if (OPTIONS_CODES.has(rawCode)) {
        skipped.push({ row: rowNumber, reason: `options activity (${rawCode}) is not supported`, raw });
        continue;
      }
      if (CASH_ONLY_CODES.has(rawCode)) {
        skipped.push({ row: rowNumber, reason: `cash movement (${rawCode}), no instrument`, raw });
        continue;
      }

      const type = CODE_MAP[rawCode];
      if (type === undefined) {
        skipped.push({ row: rowNumber, reason: `unrecognised transaction code "${rawCode}"`, raw });
        continue;
      }
      if (symbol === "") {
        skipped.push({ row: rowNumber, reason: `no instrument symbol on a ${rawCode} row`, raw });
        continue;
      }

      const signedAmount = parseMoney(cell(row, idx.amount));
      const price = parseMoney(cell(row, idx.price));
      let quantity = parseQuantity(cell(row, idx.quantity)) ?? 0;

      if (type === "split") {
        // Robinhood records splits inconsistently — sometimes a share delta,
        // sometimes a pair of rows — but the ratio is reliably in the prose.
        // Skip rather than guess: a wrong ratio silently corrupts cost basis.
        const ratio = parseSplitRatio(description);
        if (ratio === null) {
          skipped.push({
            row: rowNumber,
            reason: "split row without a readable ratio — add it manually",
            raw,
          });
          continue;
        }
        quantity = ratio;
      } else if (type === "buy" || type === "sell" || type === "transfer_in") {
        if (quantity <= 0) {
          skipped.push({ row: rowNumber, reason: `${rawCode} row with no share quantity`, raw });
          continue;
        }
      }

      // Direction lives in `type`; amounts are stored as positive magnitudes.
      const amount = signedAmount === null ? null : Math.abs(signedAmount);

      const key = [tradeDate, symbol, rawCode, quantity, price ?? "", amount ?? ""].join("|");
      const seen = occurrences.get(key) ?? 0;
      occurrences.set(key, seen + 1);

      transactions.push({
        symbol,
        type,
        tradeDate,
        quantity: Math.abs(quantity),
        price: price === null ? null : Math.abs(price),
        amount,
        fees: 0, // Robinhood reports fees as their own rows, not a column.
        externalId: `${key}#${seen}`,
        raw,
      });
    }

    return { transactions, skipped };
  }
}

function rowToObject(header: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  header.forEach((h, i) => {
    const key = h.trim();
    if (key !== "") out[key] = (row[i] ?? "").trim();
  });
  return out;
}
