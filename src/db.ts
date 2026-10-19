import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Anything with a pg-compatible query(). Lets the service layer run on pg.Pool or pg-mem in tests. */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Runs sql/*.sql in filename order, once each (tracked in schema_migrations). */
export async function migrate(db: Queryable, sqlDir = path.resolve(here, '..', 'sql')): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(sqlDir, f), 'utf8');
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    ran.push(f);
  }
  return ran;
}
