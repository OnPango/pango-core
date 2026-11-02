import type pg from 'pg';
import type {
  BusinessSector,
  ProductCount,
  TeamSize,
} from '../generated/prisma/control/enums.js';
import { schemaFromSubdomain } from '../prisma/tenant-schema.js';
import {
  applyTenantMigrations,
  type TenantMigration,
} from './tenant-migrations.js';

// Name of the system role seeded by the `base_data` migration.
export const OWNER_ROLE = 'Owner';

export interface OrganizationProfile {
  legalName: string;
  subdomain: string;
  country: string;
  city: string;
  businessSector: BusinessSector;
  teamSize: TeamSize;
  productCount: ProductCount;
  taxId?: string | null;
  contactPhone?: string | null;
}

export type OwnerAccount =
  | { id: number }
  | {
      email: string;
      name: string;
      passwordHash: string | null;
      /** NULL = the owner must confirm the email before logging in. */
      emailVerifiedAt: Date | null;
    };

export interface ProvisionResult {
  organizationId: number;
  accountId: number;
  schemaName: string;
  schemaVersion: number;
  userId: number;
}

/**
 * Creates an organization in one transaction: tenant schema + migrations, owner
 * account (or an existing one), organization, ACTIVE membership and the owner's
 * tenant user with the `Owner` role on every warehouse. Nothing is left behind if
 * any step fails. `db` must be a dedicated connection (not the transaction pooler
 * in statement mode) and is not released here.
 */
export async function provisionOrganization(
  db: pg.ClientBase,
  migrations: TenantMigration[],
  owner: OwnerAccount,
  organization: OrganizationProfile,
): Promise<ProvisionResult> {
  const schema = schemaFromSubdomain(organization.subdomain);

  await db.query('BEGIN');
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await applyTenantMigrations(db, schema, migrations);

    let accountId: number;
    if ('id' in owner) {
      accountId = owner.id;
    } else {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO "public"."accounts" ("email", "name", "password_hash", "email_verified_at")
         VALUES ($1, $2, $3, $4) RETURNING "id"`,
        [owner.email, owner.name, owner.passwordHash, owner.emailVerifiedAt],
      );
      accountId = rows[0].id;
    }

    const { rows: orgRows } = await db.query<{ id: number }>(
      `INSERT INTO "public"."organizations"
         ("tax_id", "legal_name", "country", "city", "business_sector", "team_size",
          "product_count", "contact_phone", "subdomain", "schema_name", "schema_version")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING "id"`,
      [
        organization.taxId ?? null,
        organization.legalName,
        organization.country,
        organization.city,
        organization.businessSector,
        organization.teamSize,
        organization.productCount,
        organization.contactPhone ?? null,
        organization.subdomain,
        schema,
        migrations.length,
      ],
    );
    const organizationId = orgRows[0].id;

    await db.query(
      `INSERT INTO "public"."organization_members"
         ("account_id", "organization_id", "status", "joined_at")
       VALUES ($1, $2, 'ACTIVE', now())`,
      [accountId, organizationId],
    );

    const { rows: userRows } = await db.query<{ id: number }>(
      `INSERT INTO "${schema}"."users" ("account_id") VALUES ($1) RETURNING "id"`,
      [accountId],
    );
    const userId = userRows[0].id;

    const { rowCount } = await db.query(
      `INSERT INTO "${schema}"."role_assignments" ("user_id", "role_id", "warehouse_id")
       SELECT $1, "id", NULL FROM "${schema}"."roles" WHERE "name" = $2`,
      [userId, OWNER_ROLE],
    );
    if (rowCount !== 1) {
      throw new Error(`Role ${OWNER_ROLE} not found in ${schema}`);
    }

    await db.query('COMMIT');
    return {
      organizationId,
      accountId,
      schemaName: schema,
      schemaVersion: migrations.length,
      userId,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
