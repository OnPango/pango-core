import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/tenant/client.js';
import { assertTenantSchema } from './tenant-schema.js';

export type TenantPrismaClient = PrismaClient;

// Hands out one cached client per `tenant_<slug>` schema.
// Callers must verify an ACTIVE membership before requesting a client.
@Injectable()
export class TenantPrismaService implements OnModuleDestroy {
  private readonly clients = new Map<string, PrismaClient>();
  private readonly connectionString: string;

  constructor(config: ConfigService) {
    this.connectionString = config.getOrThrow<string>('DATABASE_URL');
  }

  client(schema: string): TenantPrismaClient {
    assertTenantSchema(schema);
    let client = this.clients.get(schema);
    if (!client) {
      client = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString: this.connectionString },
          { schema },
        ),
      });
      this.clients.set(schema, client);
    }
    return client;
  }

  async onModuleDestroy() {
    await Promise.all([...this.clients.values()].map((c) => c.$disconnect()));
    this.clients.clear();
  }
}
