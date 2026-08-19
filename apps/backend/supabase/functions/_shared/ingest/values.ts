/**
 * Cell value parsers for broker exports.
 *
 * Dates are parsed with a regex and formatted by string surgery — never through
 * `new Date("03/14/2026")`, which resolves against the runtime's timezone and can
 * shift a trade a day either way depending on where the function runs.
 */

/**
 * Parse a currency cell. Handles `$1,234.56`, `($1,234.56)` (accounting negative),
 * `-$5.00`, and bare numbers. Returns a SIGNED value; callers that want a
 * magnitude take the absolute value themselves.
 */
export function parseMoney(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || text === "-" || text === "--") return null;

  const parenthesised = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[()$\s,]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  return parenthesised ? -Math.abs(value) : value;
}

/** Parse a share-quantity cell. Fractional shares are normal on Robinhood. */
export function parseQuantity(raw: string): number | null {
  const cleaned = raw.trim().replace(/[\s,]/g, "");
  if (cleaned === "") return null;
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a date cell into ISO `yyyy-mm-dd`.
 * Accepts `MM/DD/YYYY` (what Robinhood emits) and `YYYY-MM-DD`.
 */
export function parseDate(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) {
    const [, m, d, y] = slash;
    return isoDate(Number(y), Number(m), Number(d));
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return isoDate(Number(y), Number(m), Number(d));
  }

  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Reject impossible calendar dates (2026-02-30) rather than silently rolling over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Parse a split ratio out of a description like "4 for 1" / "4:1" / "4-for-1".
 * Robinhood's split rows carry the ratio in prose, not in a dedicated column.
 * Returns the multiplier applied to share count (4-for-1 → 4).
 */
export function parseSplitRatio(description: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:for|:|-for-|\/)\s*(\d+(?:\.\d+)?)/i.exec(
    description,
  );
  if (!match) return null;

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;

  return numerator / denominator;
}
