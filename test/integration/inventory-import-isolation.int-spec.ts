import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../../src/auth/auth-context.js';
import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import { InventoryImportConfig } from '../../src/inventory-imports/inventory-import-config.js';
import { InventoryImportsService } from '../../src/inventory-imports/inventory-imports.service.js';
import { MovementsService } from '../../src/movements/movements.service.js';
import { ControlPrismaService } from '../../src/prisma/control-prisma.service.js';
import { TenantPrismaService } from '../../src/prisma/tenant-prisma.service.js';
import {
  createWarehouse,
  provisionTenant,
  sessionFor,
  tenantClient,
  testDatabaseUrl,
} from './database.js';

const config = {
  getOrThrow: () => testDatabaseUrl(),
  get: () => undefined,
} as unknown as ConfigService;

const mapping = {
  sku: { column: 1, header: 'a' },
  name: { column: 2, header: 'b' },
  category: { column: 3, header: 'c' },
  stockUnit: { column: 4, header: 'd' },
  warehouse: { column: 5, header: 'e' },
  tracksLots: { column: 6, header: 'f' },
  stockQuantity: { column: 7, header: 'g' },
};

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

describe('tenant isolation of inventory imports', () => {
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
    new MovementsService(control, tenants),
  );
  let dbA: PrismaClient;
  let dbB: PrismaClient;
  let ownerA: AuthContext;
  let ownerB: AuthContext;
  let importA: number;
  let revisionA: number;

  beforeAll(async () => {
    const a = await provisionTenant('isolation-a');
    const b = await provisionTenant('isolation-b');
    dbA = tenantClient(a.schema);
    dbB = tenantClient(b.schema);
    await createWarehouse(dbA, 'NORTE');
    await createWarehouse(dbB, 'NORTE');
    ownerA = await sessionFor(dbA, a, a.userId);
    ownerB = await sessionFor(dbB, b, b.userId);

    const { import: record } = await imports.create(ownerA, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'a.xlsx',
      sheetName: 'Inventario',
      totalRows: 1,
      mapping,
    });
    importA = record.id;
    await imports.appendRows(ownerA, importA, {
      batchNumber: 1,
      rows: [
        {
          rowNumber: 2,
          values: {
            sku: 'SECRET-A',
            name: 'Secreto',
            category: 'Privada',
            stockUnit: 'ud',
            warehouse: 'NORTE',
            tracksLots: 'Cantidad',
            stockQuantity: '5',
          },
        },
      ],
    });
    revisionA = (await imports.validate(ownerA, importA)).import.revision;
  });

  afterAll(async () => {
    await Promise.all([
      dbA.$disconnect(),
      dbB.$disconnect(),
      tenants.onModuleDestroy(),
    ]);
    await control.$disconnect();
  });

  it("never reaches another organization's import by its id", async () => {
    // B's session works on B's schema only, where import `importA` does not exist.
    expect(await errorOf(imports.get(ownerB, importA))).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect(await errorOf(imports.rowPage(ownerB, importA, {}))).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect(await errorOf(imports.issuePage(ownerB, importA, {}))).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect(await errorOf(imports.validate(ownerB, importA))).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect(
      await errorOf(imports.confirm(ownerB, importA, { revision: revisionA })),
    ).toBe('IMPORT_NOT_FOUND');
    expect(
      await errorOf(
        imports.appendRows(ownerB, importA, {
          batchNumber: 2,
          rows: [{ rowNumber: 3, values: { sku: 'X' } }],
        }),
      ),
    ).toBe('IMPORT_NOT_FOUND');
    expect(await errorOf(imports.cancel(ownerB, importA))).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect((await imports.list(ownerB, {})).total).toBe(0);
  });

  it('is untouched by the other organization, and leaks nothing into it', async () => {
    expect(
      await dbA.inventoryImport.findUniqueOrThrow({ where: { id: importA } }),
    ).toMatchObject({
      status: 'READY',
      revision: revisionA,
      receivedRows: 1,
    });
    // A's own import confirms normally; nothing appears in B.
    await imports.confirm(ownerA, importA, { revision: revisionA });
    expect(await dbA.product.count({ where: { sku: 'SECRET-A' } })).toBe(1);
    expect(await dbB.product.count()).toBe(0);
    expect(await dbB.category.count()).toBe(0);
    expect(await dbB.movement.count()).toBe(0);
    expect(await dbB.inventoryImport.count()).toBe(0);
  });

  it("does not let one organization's open import block another's", async () => {
    await dbA.inventoryImport.create({
      data: {
        clientRequestId: randomUUID(),
        createdById: ownerA.user.id,
        schemaVersion: 1,
        fileName: 'open.xlsx',
        sheetName: 'Inventario',
        totalRows: 1,
        mapping: {},
        requestFingerprint: 'a'.repeat(64),
      },
    });
    await expect(
      imports.create(ownerB, {
        clientRequestId: randomUUID(),
        schemaVersion: 1,
        fileName: 'b.xlsx',
        sheetName: 'Inventario',
        totalRows: 1,
        mapping,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
