/**
 * Alias-list column resolution.
 *
 * Broker exports rename and reorder columns between revisions, so nothing here
 * makes a positional assumption. A caller asks for the first header that matches
 * any of a list of aliases:
 *
 *   const col = makeColumnResolver(header);
 *   const qtyIdx = col(["quantity", "shares", "qty"]);
 *
 * Header matching is case-, space- and punctuation-insensitive, so "Trans Code",
 * "trans_code" and "TRANS-CODE" all resolve alike.
 */

export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type ColumnResolver = (aliases: string[]) => number | null;

export function makeColumnResolver(header: string[]): ColumnResolver {
  const index = new Map<string, number>();

  header.forEach((raw, i) => {
    const key = normalizeHeader(raw);
    // First occurrence wins — duplicated headers keep the leftmost column.
    if (key !== "" && !index.has(key)) index.set(key, i);
  });

  return (aliases) => {
    for (const alias of aliases) {
      const hit = index.get(normalizeHeader(alias));
      if (hit !== undefined) return hit;
    }
    return null;
  };
}

/** Read a cell by index, trimmed. Out-of-range and missing cells read as "". */
export function cell(row: string[], index: number | null): string {
  if (index === null || index < 0 || index >= row.length) return "";
  return (row[index] ?? "").trim();
}
