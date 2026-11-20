import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  provisionOrganization,
  type OrganizationProfile,
  type OwnerAccount,
  type ProvisionResult,
} from './provision-organization.js';
import {
  readTenantMigrations,
  type TenantMigration,
} from './tenant-migrations.js';

// Provisions organizations from the API. Uses DIRECT_URL (session pooler), like the
// CLI, because provisioning runs DDL inside one long transaction.
@Injectable()
export class ProvisioningService implements OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly migrationsDir: string;
  private migrations?: Promise<TenantMigration[]>;

  constructor(config: ConfigService) {
    this.pool = new pg.Pool({
      connectionString: config.getOrThrow<string>('DIRECT_URL'),
      max: 2,
    });
    this.migrationsDir = resolve(
      config.get<string>('TENANT_MIGRATIONS_DIR') ?? 'prisma/tenant/migrations',
    );
  }

  async provision(
    owner: OwnerAccount,
    organization: OrganizationProfile,
  ): Promise<ProvisionResult> {
    this.migrations ??= readTenantMigrations(this.migrationsDir).catch(
      (error: unknown) => {
        this.migrations = undefined;
        throw error;
      },
    );
    const migrations = await this.migrations;
    const db = await this.pool.connect();
    try {
      return await provisionOrganization(db, migrations, owner, organization);
    } finally {
      db.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
