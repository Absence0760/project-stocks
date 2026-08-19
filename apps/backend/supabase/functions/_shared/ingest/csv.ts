/**
 * Minimal RFC 4180 CSV reader.
 *
 * Hand-rolled rather than pulled from a registry: broker exports are small, the
 * grammar is tiny, and an edge function with no third-party import is one less
 * supply-chain surface. Handles quoted fields containing commas, newlines and
 * doubled quotes, plus CRLF and a UTF-8 BOM (Robinhood's export carries one).
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < input.length) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }

    field += c;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Drop rows that are entirely empty — trailing blank lines, separator rows. */
export function dropBlankRows(rows: string[][]): string[][] {
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}
