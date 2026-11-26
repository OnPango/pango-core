// Integration tests run against a local, throwaway PostgreSQL only (see
// docker-compose.test.yml). Everything here refuses any other database, because
// resetting it drops every schema.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AuthContext, RoleGrant } from '../../src/auth/auth-context.js';
import { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import { provisionOrganization } from '../../src/tenancy/provision-organization.js';
import { readTenantMigrations } from '../../src/tenancy/tenant-migrations.js';

const DEFAULT_URL = 'postgresql://pango:pango@127.0.0.1:54329/pango_test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Connection string of the test database; throws unless it is local. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const { hostname } = new URL(url);
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `Integration tests only run against a local database, not ${hostname}`,
    );
  }
  return url;
}

async function withClient<T>(run: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: testDatabaseUrl() });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}

/** Drops every tenant schema and recreates `public` with the control migrations. */
export async function resetDatabase(): Promise<void> {
  await withClient(async (db) => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT nspname AS "name" FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'`,
    );
    for (const { name } of rows) {
      await db.query(`DROP SCHEMA "${name}" CASCADE`);
    }
    await db.query('DROP SCHEMA IF EXISTS "public" CASCADE');
    await db.query('CREATE SCHEMA "public"');

    const dir = join(process.cwd(), 'prisma/control/migrations');
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const sql = await readFile(join(dir, name, 'migration.sql'), 'utf8');
      await db.query(sql);
    }
  });
}

export interface TestTenant {
  schema: string;
  organizationId: number;
  accountId: number;
  /** The Owner's tenant user. */
  userId: number;
}

const tenantMigrations = () =>
  readTenantMigrations(join(process.cwd(), 'prisma/tenant/migrations'));

/**
 * Provisions an organization exactly as sign-up does, with its Owner. With
 * `before`, only the tenant migrations named before it are applied, to stand for
 * an organization that existed before that migration (see `applyMigration`).
 */
export async function provisionTenant(
  subdomain: string,
  options: { before?: string } = {},
): Promise<TestTenant> {
  const all = await tenantMigrations();
  const migrations = options.before
    ? all.filter((m) => m.name < options.before!)
    : all;
  return withClient(async (db) => {
    const result = await provisionOrganization(
      db,
      migrations,
      {
        email: `owner@${subdomain}.test`,
        name: 'Test Owner',
        passwordHash: null,
        emailVerifiedAt: new Date(),
      },
      {
        legalName: `${subdomain} SAS`,
        subdomain,
        country: 'CO',
        city: 'Barranquilla',
        businessSector: 'RETAIL',
        teamSize: 'SIZE_1_5',
        productCount: 'COUNT_1_100',
      },
    );
    return {
      schema: result.schemaName,
      organizationId: result.organizationId,
      accountId: result.accountId,
      userId: result.userId,
    };
  });
}

/** Applies one tenant migration to an existing tenant, as `pnpm tenant:migrate` would. */
export async function applyMigration(
  schema: string,
  name: string,
): Promise<void> {
  const migration = (await tenantMigrations()).find((m) => m.name === name);
  if (!migration) throw new Error(`Unknown tenant migration ${name}`);
  await withClient(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL search_path TO "${schema}"`);
      await db.query(migration.sql);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
}

/** A Prisma client bound to one tenant schema of the test database. */
export function tenantClient(schema: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl() }, { schema }),
  });
}

/** A warehouse with its DEFAULT location, as `POST /warehouses` creates it. */
export async function createWarehouse(db: PrismaClient, code: string) {
  return db.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.create({ data: { code, name: code } });
    const location = await tx.location.create({
      data: { warehouseId: warehouse.id, code: 'DEFAULT' },
    });
    return tx.warehouse.update({
      where: { id: warehouse.id },
      data: { defaultLocationId: location.id },
    });
  });
}

/** The session AuthGuard would build for a tenant user, from their role assignments. */
export async function sessionFor(
  db: PrismaClient,
  tenant: TestTenant,
  userId: number,
): Promise<AuthContext> {
  const assignments = await db.roleAssignment.findMany({
    where: { userId },
    orderBy: { id: 'asc' },
    include: {
      warehouse: { select: { id: true, name: true } },
      role: { include: { permissions: { include: { permission: true } } } },
    },
  });
  const roles: RoleGrant[] = assignments.map((a) => ({
    id: a.role.id,
    name: a.role.name,
    isSystem: a.role.isSystem,
    warehouse: a.warehouse,
    permissions: a.role.permissions.map((p) => p.permission.code),
  }));
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    account: { id: user.accountId, email: 'user@test', name: 'User' },
    organization: {
      id: tenant.organizationId,
      subdomain: 'test',
      legalName: 'Test',
      schemaName: tenant.schema,
    },
    user: { id: userId, jobTitle: null, roles },
  };
}

/** A tenant user with one role on each given warehouse. */
export async function createUser(
  db: PrismaClient,
  accountId: number,
  roleName: string,
  warehouseIds: number[],
) {
  const role = await db.role.findUniqueOrThrow({ where: { name: roleName } });
  const user = await db.user.create({ data: { accountId } });
  await db.roleAssignment.createMany({
    data: warehouseIds.map((warehouseId) => ({
      userId: user.id,
      roleId: role.id,
      warehouseId,
    })),
  });
  return user;
}
