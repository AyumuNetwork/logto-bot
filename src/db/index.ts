import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_SQL } from './schema.js';

export type Database = DatabaseSync;

/** Additive, idempotent column migrations for databases created by older builds. */
const COLUMN_MIGRATIONS: { table: string; column: string; definition: string }[] = [
  { table: 'login_links', column: 'context_json', definition: 'TEXT' },
];

const applyColumnMigrations = (db: Database): void => {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${migration.table})`).all() as { name: string }[];
    if (columns.some((column) => column.name === migration.column)) {
      continue;
    }
    db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`);
  }
};

/**
 * Open (and migrate) the SQLite database. Uses the built-in `node:sqlite`
 * driver so there is no native build step in the container.
 */
export const openDatabase = (path: string): Database => {
  const absolute = path === ':memory:' ? path : resolve(path);

  if (absolute !== ':memory:') {
    mkdirSync(dirname(absolute), { recursive: true });
  }

  const db = new DatabaseSync(absolute);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA_SQL);
  applyColumnMigrations(db);
  return db;
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
