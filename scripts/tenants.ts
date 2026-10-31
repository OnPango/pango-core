// Provisions and migrates tenant schemas.
//
//   pnpm tenant:create --subdomain demo --legal-name "Demo SAS" --country CO --city Bogotá \
//                      --business-sector RETAIL --team-size SIZE_1_5 --product-count COUNT_1_100 \
//                      --email owner@demo.co --name "Demo Owner" \
//                      [--tax-id 900000000-1] [--contact-phone <phone>] [--cognito-sub <sub>]
//   pnpm tenant:migrate           # migrates every tenant registered in public.organizations
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
import { PrismaClient as TenantClient } from '../src/generated/prisma/tenant/client.js';
import {
  assertTenantSchema,
  schemaFromSubdomain,
} from '../src/prisma/tenant-schema.js';

// Name of the system role seeded by the `base_data` migration.
const OWNER_ROLE = 'Owner';

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
      'cognito-sub': { type: 'string' },
    },
  });
  const { subdomain, city, email, name } = values;
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
        '--team-size --product-count --email --name [--tax-id] [--contact-phone] [--cognito-sub]',
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
  const taxId = values['tax-id'];
  const contactPhone = values['contact-phone'];
  const cognitoSub = values['cognito-sub'] ?? `local|${email}`;

  // 1. Validate the subdomain and derive the schema name.
  const schema = schemaFromSubdomain(subdomain);

  const db = new pg.Client({ connectionString: DIRECT_URL });
  const control = new ControlClient({
    adapter: new PrismaPg({ connectionString: DIRECT_URL }),
  });
  await db.connect();

  try {
    if (await control.organization.findUnique({ where: { subdomain } })) {
      throw new Error(
        `An organization with subdomain ${subdomain} already exists`,
      );
    }

    // 2. Create the schema.
    await db.query(`CREATE SCHEMA "${schema}"`);
    try {
      // 3. Apply the tenant migrations.
      migrateSchema(schema);
      const schemaVersion = await appliedMigrations(db, schema);

      // The account lives in public; its id is needed for the tenant user.
      const account = await control.account.upsert({
        where: { email },
        update: {},
        create: { cognitoSub, email, name },
      });

      // 4. Creator user with the owner role on every warehouse.
      const tenant = new TenantClient({
        adapter: new PrismaPg({ connectionString: DIRECT_URL }, { schema }),
      });
      try {
        const ownerRole = await tenant.role.findUniqueOrThrow({
          where: { name: OWNER_ROLE },
        });
        await tenant.user.create({
          data: {
            accountId: account.id,
            roleAssignments: {
              create: { roleId: ownerRole.id, warehouseId: null },
            },
          },
        });
      } finally {
        await tenant.$disconnect();
      }

      // 5. Organization and ACTIVE membership in public.
      await control.organization.create({
        data: {
          taxId,
          legalName,
          country,
          city,
          businessSector,
          teamSize,
          productCount,
          contactPhone,
          subdomain,
          schemaName: schema,
          schemaVersion,
          memberships: {
            create: {
              accountId: account.id,
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
          },
        },
      });

      console.log(
        `✔ Tenant ${schema} created (schema version ${schemaVersion})`,
      );
    } catch (error) {
      // 6. Drop the schema if anything fails.
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      throw error;
    }
  } finally {
    await db.end();
    await control.$disconnect();
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
