// Provisions and migrates tenant schemas.
//
//   pnpm tenant:create --subdomain demo --legal-name "Demo SAS" --country CO --city Bogotá \
//                      --business-sector RETAIL --team-size SIZE_1_5 --product-count COUNT_1_100 \
//                      --email owner@demo.co --name "Demo Owner" \
//                      [--password <password>] [--tax-id 900000000-1] [--contact-phone <phone>]
//   pnpm tenant:migrate           # migrates every tenant registered in public.organizations
//
// `create` runs the same provisioning as POST /auth/signup (src/tenancy).
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient as ControlClient } from '../src/generated/prisma/control/client.js';
import {
  BusinessSector,
  ProductCount,
  TeamSize,
} from '../src/generated/prisma/control/enums.js';
import { hashPassword } from '../src/auth/secrets.js';
import { assertTenantSchema } from '../src/prisma/tenant-schema.js';
import {
  type OwnerAccount,
  provisionOrganization,
} from '../src/tenancy/provision-organization.js';
import { isValidSubdomain } from '../src/tenancy/subdomain.js';
import { readTenantMigrations } from '../src/tenancy/tenant-migrations.js';

const TENANT_MIGRATIONS_DIR = 'prisma/tenant/migrations';

const DIRECT_URL = process.env.DIRECT_URL;
if (!DIRECT_URL) throw new Error('DIRECT_URL is not set');

function migrateSchema(schema: string) {
  execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'deploy',
      '--config',
      'prisma/tenant.config.ts',
    ],
    { stdio: 'inherit', env: { ...process.env, TENANT_SCHEMA: schema } },
  );
}

function parseEnum<T extends string>(
  option: string,
  value: string,
  values: Record<string, T>,
): T {
  const allowed = Object.values(values);
  if (!allowed.includes(value as T)) {
    throw new Error(`--${option} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

async function appliedMigrations(db: pg.Client, schema: string) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "${assertTenantSchema(schema)}"."_prisma_migrations"
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  return rows[0].n;
}

async function create(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      subdomain: { type: 'string' },
      'tax-id': { type: 'string' },
      'legal-name': { type: 'string' },
      country: { type: 'string' },
      city: { type: 'string' },
      'business-sector': { type: 'string' },
      'team-size': { type: 'string' },
      'product-count': { type: 'string' },
      'contact-phone': { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
    },
  });
  const { subdomain, city, name, password } = values;
  const email = values.email?.trim().toLowerCase();
  const legalName = values['legal-name'];
  const country = values.country?.toUpperCase();
  if (
    !subdomain ||
    !legalName ||
    !country ||
    !city ||
    !values['business-sector'] ||
    !values['team-size'] ||
    !values['product-count'] ||
    !email ||
    !name
  ) {
    throw new Error(
      'Usage: tenant:create --subdomain --legal-name --country --city --business-sector ' +
        '--team-size --product-count --email --name [--password] [--tax-id] [--contact-phone]',
    );
  }
  if (!isValidSubdomain(subdomain)) {
    throw new Error(
      '--subdomain must be 2-41 lowercase letters, digits or inner hyphens, and not reserved',
    );
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error('--country must be an ISO 3166-1 alpha-2 code (e.g. CO)');
  }
  const businessSector = parseEnum(
    'business-sector',
    values['business-sector'],
    BusinessSector,
  );
  const teamSize = parseEnum('team-size', values['team-size'], TeamSize);
  const productCount = parseEnum(
    'product-count',
    values['product-count'],
    ProductCount,
  );

  const db = new pg.Client({ connectionString: DIRECT_URL });
  await db.connect();
  try {
    // An existing account is reused as is; a new one gets --password (or none,
    // and then it cannot log in until it accepts an invitation).
    const { rows } = await db.query<{ id: number }>(
      'SELECT "id" FROM "public"."accounts" WHERE "email" = $1',
      [email],
    );
    const owner: OwnerAccount = rows[0]
      ? { id: rows[0].id }
      : {
          email,
          name,
          passwordHash: password ? await hashPassword(password) : null,
          // Accounts created by an operator are trusted.
          emailVerifiedAt: new Date(),
        };
    if (!rows[0] && !password) {
      console.warn('! No --password given: the owner cannot log in yet');
    }

    const migrations = await readTenantMigrations(TENANT_MIGRATIONS_DIR);
    const result = await provisionOrganization(db, migrations, owner, {
      legalName,
      subdomain,
      country,
      city,
      businessSector,
      teamSize,
      productCount,
      taxId: values['tax-id'],
      contactPhone: values['contact-phone'],
    });
    console.log(
      `✔ Tenant ${result.schemaName} created (schema version ${result.schemaVersion})`,
    );
  } finally {
    await db.end();
  }
}

async function migrateAll() {
  const db = new pg.Client({ connectionString: DIRECT_URL });
  const control = new ControlClient({
    adapter: new PrismaPg({ connectionString: DIRECT_URL }),
  });
  await db.connect();
  try {
    const organizations = await control.organization.findMany({
      select: { id: true, schemaName: true },
      orderBy: { id: 'asc' },
    });
    for (const { id, schemaName } of organizations) {
      console.log(`→ ${schemaName}`);
      migrateSchema(schemaName);
      await control.organization.update({
        where: { id },
        data: { schemaVersion: await appliedMigrations(db, schemaName) },
      });
    }
  } finally {
    await db.end();
    await control.$disconnect();
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'create') await create(rest);
else if (command === 'migrate') await migrateAll();
else throw new Error('Unknown command. Use: create | migrate');
