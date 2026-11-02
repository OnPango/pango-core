import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { assertTenantSchema } from '../prisma/tenant-schema.js';

export interface TenantMigration {
  name: string;
  sql: string;
  /** SHA-256 of the file, the same checksum `prisma migrate deploy` records. */
  checksum: string;
}

// Same DDL Prisma uses, so `prisma migrate deploy` (pnpm tenant:migrate) keeps
// working on schemas provisioned at runtime.
const PRISMA_MIGRATIONS_TABLE = `
CREATE TABLE "_prisma_migrations" (
    "id"                  VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"            VARCHAR(64) NOT NULL,
    "finished_at"         TIMESTAMPTZ,
    "migration_name"      VARCHAR(255) NOT NULL,
    "logs"                TEXT,
    "rolled_back_at"      TIMESTAMPTZ,
    "started_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

/** Reads `<dir>/<timestamp>_<name>/migration.sql` in name order. */
export async function readTenantMigrations(
  dir: string,
): Promise<TenantMigration[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`No tenant migrations found in ${dir}`);
  }
  return Promise.all(
    names.map(async (name) => {
      const file = await readFile(join(dir, name, 'migration.sql'));
      return {
        name,
        sql: file.toString('utf8'),
        checksum: createHash('sha256').update(file).digest('hex'),
      };
    }),
  );
}

/**
 * Applies every migration to an empty tenant schema and records them in its
 * `_prisma_migrations` table. Must run inside a transaction opened by the caller:
 * it changes `search_path` with `SET LOCAL` (the migrations use unqualified names).
 */
export async function applyTenantMigrations(
  db: pg.ClientBase,
  schema: string,
  migrations: TenantMigration[],
): Promise<void> {
  assertTenantSchema(schema);
  await db.query(`SET LOCAL search_path TO "${schema}"`);
  await db.query(PRISMA_MIGRATIONS_TABLE);
  for (const migration of migrations) {
    await db.query(migration.sql);
    await db.query(
      `INSERT INTO "_prisma_migrations"
         ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
       VALUES ($1, $2, now(), $3, now(), 1)`,
      [randomUUID(), migration.checksum, migration.name],
    );
  }
  await db.query('RESET search_path');
}
