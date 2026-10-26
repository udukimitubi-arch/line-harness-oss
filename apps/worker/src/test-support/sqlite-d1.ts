// Local/test adapter only. Production routes use the Cloudflare D1 binding.
import Database from 'better-sqlite3';
type SQLInputValue = string | number | bigint | Buffer | null;
// D1 accepts numbered placeholders (?1, ?2 …, each usable more than once).
// better-sqlite3 binds them differently, so rewrite them to plain "?" in order.
const NUMBERED = /\?(\d+)/g;
function plain(sql: string): string {
  return sql.replace(NUMBERED, '?');
}
function numberedToPositional(sql: string, args: SQLInputValue[]): { values: SQLInputValue[] } {
  const refs = [...sql.matchAll(NUMBERED)].map((m) => Number(m[1]));
  return { values: refs.length ? refs.map((n) => args[n - 1]) : args };
}

export function sqliteD1(path = ':memory:'): { db: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(path);
  function prepare(sql: string, values: SQLInputValue[] = []): D1PreparedStatement {
    return {
      bind(...args: unknown[]) { return prepare(sql, numberedToPositional(sql, args as SQLInputValue[]).values); },
      async first<T>(column?: string) {
        const row = sqlite.prepare(plain(sql)).get(...values) as Record<string, SQLInputValue> | undefined;
        return (column ? row?.[column] ?? null : row ?? null) as T | null;
      },
      async all<T>() {
        const results = sqlite.prepare(plain(sql)).all(...values) as T[];
        return { success: true, results, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: results.length, rows_written: 0 } };
      },
      async run<T>() {
        const info = sqlite.prepare(plain(sql)).run(...values);
        return { success: true, results: [] as T[], meta: { changes: Number(info.changes), duration: 0, last_row_id: Number(info.lastInsertRowid), changed_db: !!info.changes, size_after: 0, rows_read: 0, rows_written: Number(info.changes) } };
      },
      async raw<T>() { return sqlite.prepare(plain(sql)).all(...values).map(row => Object.values(row as Record<string, SQLInputValue>)) as T[]; },
    } as D1PreparedStatement;
  }
  const db = { prepare } as D1Database;
  return { db, sqlite };
}
