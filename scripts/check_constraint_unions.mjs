#!/usr/bin/env node
/**
 * Drift guard: Postgres CHECK constraints vs their TypeScript unions.
 *
 * A narrow union that exists in two places rots the moment someone adds a value
 * to one of them. Adding an adapter means touching both the `source` CHECK in the
 * schema migration and `INGEST_SOURCES` in the ingest types — this fails CI when
 * only one moves.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA = join(repoRoot, "apps/backend/supabase/migrations/20260819120000_initial_schema.sql");
const TYPES = join(repoRoot, "apps/backend/supabase/functions/_shared/ingest/types.ts");
const AI_SCHEMA = join(repoRoot, "apps/backend/supabase/migrations/20260819150000_ai_digests.sql");
const AI_TYPES = join(repoRoot, "apps/backend/supabase/functions/_shared/ai/types.ts");

/** Each pair: a CHECK constraint in SQL and the const array it must match. */
const PAIRS = [
  {
    label: "ingest source",
    sql: { file: SCHEMA, table: "transactions", column: "source" },
    ts: { file: TYPES, constName: "INGEST_SOURCES" },
  },
  {
    label: "transaction type",
    sql: { file: SCHEMA, table: "transactions", column: "type" },
    ts: { file: TYPES, constName: "TRANSACTION_TYPES" },
  },
  {
    label: "digest kind",
    sql: { file: AI_SCHEMA, table: "ai_digests", column: "kind" },
    ts: { file: AI_TYPES, constName: "DIGEST_KINDS" },
  },
];

/**
 * Pull the allowed values out of `<column> ... check (<column> in ('a', 'b'))`.
 * Scoped to the named table's CREATE TABLE body so an identically-named column on
 * another table can't satisfy the match.
 */
function sqlValues(file, table, column) {
  const source = readFileSync(file, "utf8");

  const tableStart = source.indexOf(`create table ${table} (`);
  if (tableStart === -1) throw new Error(`no "create table ${table}" in ${file}`);
  const tableEnd = source.indexOf("\n);", tableStart);
  if (tableEnd === -1) throw new Error(`unterminated "create table ${table}" in ${file}`);
  const body = source.slice(tableStart, tableEnd);

  const pattern = new RegExp(
    `${column}\\s+text\\s+not null\\s+check\\s*\\(\\s*${column}\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`,
    "i",
  );
  const match = pattern.exec(body);
  if (!match) throw new Error(`no CHECK ... in (...) for ${table}.${column} in ${file}`);

  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Pull the values out of `export const NAME = ["a", "b"] as const;`. */
function tsValues(file, constName) {
  const source = readFileSync(file, "utf8");
  const pattern = new RegExp(`export const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`no "export const ${constName} = [...] as const" in ${file}`);

  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

let failed = false;

for (const pair of PAIRS) {
  let sql;
  let ts;
  try {
    sql = sqlValues(pair.sql.file, pair.sql.table, pair.sql.column);
    ts = tsValues(pair.ts.file, pair.ts.constName);
  } catch (error) {
    console.error(`✗ ${pair.label}: ${error.message}`);
    failed = true;
    continue;
  }

  const onlySql = sql.filter((v) => !ts.includes(v));
  const onlyTs = ts.filter((v) => !sql.includes(v));

  if (onlySql.length === 0 && onlyTs.length === 0) {
    console.log(`✓ ${pair.label}: ${sql.length} values agree`);
    continue;
  }

  failed = true;
  console.error(`✗ ${pair.label}: CHECK constraint and ${pair.ts.constName} disagree`);
  if (onlySql.length > 0) {
    console.error(`    only in SQL (${pair.sql.table}.${pair.sql.column}): ${onlySql.join(", ")}`);
  }
  if (onlyTs.length > 0) {
    console.error(`    only in TS  (${pair.ts.constName}): ${onlyTs.join(", ")}`);
  }
}

if (failed) {
  console.error("\nAdd the value to both places, or remove it from both.");
  process.exit(1);
}
