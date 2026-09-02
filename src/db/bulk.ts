/**
 * Bulk-upsert machinery shared by every batched write in src/db.
 *
 * D1 caps bound parameters at 100 per statement (confirmed against the docs
 * and empirically: a 102-parameter statement fails with
 * "D1_ERROR: too many SQL variables"). A naive multi-row
 * `INSERT ... VALUES (?,?,...), (?,?,...)` therefore cannot fit anywhere
 * near 100 rows once a table has more than a handful of columns -- 656 rows
 * of the 25-column `elements` table would need ~164 statements at 4 rows
 * each, blowing the 50-D1-queries-per-invocation budget on its own.
 *
 * Instead, each statement here carries its whole row batch as ONE bound
 * parameter: a JSON array, unpacked inside SQLite with the built-in
 * `json_each()` table-valued function and `json_extract()`. That means
 * exactly one `?` per statement no matter how many rows or columns it
 * covers, so the 100-bound-parameter cap is a non-issue. Rows are still
 * split into chunks (see `UPSERT_CHUNK_SIZE`) so that a single upsert of the
 * whole `elements` or `element_gw_stats` table is a *handful* of statements
 * rather than one that touches the entire table at once, per the ingest
 * workflow's chunking requirement -- not because the param cap forces it.
 *
 * Values still never touch the SQL string directly: `JSON.stringify` is the
 * only thing that turns a row into text, and it goes in as a single bound
 * parameter, so free-text fields (player news, names with apostrophes) can't
 * break out of the statement.
 */

const HAS_TERMINATING_CLAUSE = 'WHERE 1=1';

export interface JsonUpsertSpec {
  table: string;
  /** Column order also fixes the order json_extract() pulls values in --
   * doesn't need to match the row object's key order. */
  columns: readonly string[];
  conflictColumns: readonly string[];
  /**
   * Columns compared old-vs-new (`excluded.col IS NOT col`) to decide
   * whether the UPDATE actually runs. MUST exclude any column that is set
   * unconditionally on every call regardless of real data change (an
   * `updated_at`/`computed_at` stamp) -- including one in the guard means
   * every row "changes" every time and the whole point of the guard (skip
   * unchanged rows, stay well under the 100k-writes/day budget) is lost.
   * Pass an empty array to always overwrite on conflict.
   */
  guardColumns: readonly string[];
}

/** Rows per statement for a chunked bulk upsert. Not derived from the
 * bound-parameter cap (each statement uses exactly one parameter regardless
 * of this number) -- it exists to keep each statement's JSON payload small
 * and to spread a big upsert over several statements. 656 rows at this
 * chunk size is 7 statements, matching what a single Worker invocation can
 * comfortably afford against the 50-D1-queries-per-invocation budget. */
export const UPSERT_CHUNK_SIZE = 100;

export function chunkRows<T>(rows: readonly T[], size = UPSERT_CHUNK_SIZE): T[][] {
  if (rows.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/**
 * Builds one upsert statement for `rows` (already-chunked). Returns `null`
 * for an empty chunk so callers can `.filter()` blindly.
 *
 * `WHERE 1=1` after `FROM json_each(?)` is not decorative: without some
 * clause ending the SELECT, SQLite's parser reads the `ON CONFLICT` that
 * immediately follows `json_each(?)` as the start of a join-constraint
 * (`ON <expr>`) rather than the upsert-clause, and fails with a syntax error
 * near `DO`. This was hit and fixed empirically while validating the
 * approach -- do not remove it as dead code.
 */
export function buildJsonUpsertStatement(
  db: D1Database,
  spec: JsonUpsertSpec,
  rows: readonly unknown[],
): D1PreparedStatement | null {
  if (rows.length === 0) return null;

  const selectCols = spec.columns.map((c) => `json_extract(value, '$.${c}') AS ${c}`).join(', ');
  const updateCols = spec.columns.filter((c) => !spec.conflictColumns.includes(c));
  const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
  const guardClause = spec.guardColumns.map((c) => `excluded.${c} IS NOT ${c}`).join(' OR ');

  const sql =
    `INSERT INTO ${spec.table} (${spec.columns.join(', ')}) ` +
    `SELECT ${selectCols} FROM json_each(?) ${HAS_TERMINATING_CLAUSE} ` +
    `ON CONFLICT(${spec.conflictColumns.join(', ')}) DO UPDATE SET ${setClause}` +
    (guardClause.length > 0 ? ` WHERE ${guardClause}` : '');

  return db.prepare(sql).bind(JSON.stringify(rows));
}

/**
 * Chunks `rows` and builds one statement per chunk. The caller hands the
 * result to `db.batch()`; each statement counts as one D1 query, so a
 * caller assembling several of these in one Worker invocation must keep
 * the total under the 50-query budget (a full 656-row table at the default
 * chunk size is 7).
 */
export function buildChunkedJsonUpserts(
  db: D1Database,
  spec: JsonUpsertSpec,
  rows: readonly unknown[],
  chunkSize = UPSERT_CHUNK_SIZE,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkRows(rows, chunkSize)) {
    const stmt = buildJsonUpsertStatement(db, spec, chunk);
    if (stmt !== null) statements.push(stmt);
  }
  return statements;
}

/** Statement count a chunked upsert of `rowCount` rows will cost against the
 * 50-D1-queries-per-invocation budget, at the given chunk size. Exported so
 * callers (the ingest workflow) can budget before calling. */
export function upsertStatementCount(rowCount: number, chunkSize = UPSERT_CHUNK_SIZE): number {
  return Math.ceil(rowCount / chunkSize);
}
