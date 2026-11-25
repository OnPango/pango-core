import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../../src/auth/auth-context.js';
import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import type { CreateInventoryImportDto } from '../../src/inventory-imports/dto.js';
import { InventoryImportConfig } from '../../src/inventory-imports/inventory-import-config.js';
import { InventoryImportsService } from '../../src/inventory-imports/inventory-imports.service.js';
import { MovementsService } from '../../src/movements/movements.service.js';
import { ControlPrismaService } from '../../src/prisma/control-prisma.service.js';
import { TenantPrismaService } from '../../src/prisma/tenant-prisma.service.js';
import {
  createUser,
  createWarehouse,
  provisionTenant,
  sessionFor,
  tenantClient,
  testDatabaseUrl,
  type TestTenant,
} from './database.js';

const config = {
  getOrThrow: () => testDatabaseUrl(),
  get: () => undefined,
} as unknown as ConfigService;

function request(
  overrides: Partial<CreateInventoryImportDto> = {},
): CreateInventoryImportDto {
  return {
    clientRequestId: randomUUID(),
    schemaVersion: 1,
    fileName: 'inventario.xlsx',
    sheetName: 'Inventario',
    totalRows: 3,
    mapping: {
      sku: { column: 1, header: 'Código producto *' },
      name: { column: 2, header: 'Producto *' },
      category: { column: 3, header: 'Categoría *' },
      stockUnit: { column: 4, header: 'Unidad de medida *' },
      warehouse: { column: 5, header: 'Bodega *' },
      tracksLots: { column: 6, header: 'Seguimiento *' },
      stockQuantity: { column: 7, header: 'Saldo inicial *' },
    },
    ...overrides,
  };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as {
      code: string;
      importId?: number;
    };
  }
  throw new Error('Expected the promise to reject');
}

describe('inventory import sessions', () => {
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
    new MovementsService(control, tenants),
  );
  let tenant: TestTenant;
  let db: PrismaClient;
  let owner: AuthContext;
  let northAdmin: AuthContext;
  let north: number;
  let south: number;

  beforeAll(async () => {
    tenant = await provisionTenant('sessions');
    db = tenantClient(tenant.schema);
    north = (await createWarehouse(db, 'NORTH')).id;
    south = (await createWarehouse(db, 'SOUTH')).id;
    owner = await sessionFor(db, tenant, tenant.userId);
    const admin = await createUser(db, 901, 'Admin', [north]);
    northAdmin = await sessionFor(db, tenant, admin.id);
  });

  afterEach(async () => {
    // Every test starts without an open import.
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
    await control.$disconnect();
  });

  it('lists the 21 fields, the units with their aliases and the limits', async () => {
    const fields = await imports.fields(owner);
    expect(fields.fields).toHaveLength(21);
    expect(fields.limits).toEqual({
      maxRowsPerBatch: 5000,
      maxRowsPerImport: 5000,
      maxRequestBytes: 1048576,
      maxValueChars: 2000,
      maxRowChars: 4096,
      expiryHours: 24,
    });
    expect(fields.units.map((u) => u.code)).toEqual([
      'BX',
      'EA',
      'GRM',
      'KGM',
      'LTR',
      'MLT',
      'MTR',
      'PK',
    ]);
    expect(fields.units.find((u) => u.code === 'EA')?.aliases).toContain(
      'unidad',
    );
  });

  it('creates an import and answers a repeated request with the same one', async () => {
    const body = request();
    const first = await imports.create(owner, body);
    const again = await imports.create(owner, body);

    expect(first.replayed).toBe(false);
    expect(first.import).toMatchObject({
      status: 'RECEIVING',
      totalRows: 3,
      receivedRows: 0,
      revision: 0,
      summary: null,
      createdBy: { id: tenant.userId, name: 'Test Owner' },
    });
    expect(first.import.expiresAt?.getTime()).toBe(
      first.import.createdAt.getTime() + 24 * 3_600_000,
    );
    expect(again).toEqual({ import: first.import, replayed: true });
    expect(
      (await errorOf(imports.create(owner, { ...body, totalRows: 4 }))).code,
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('creates one import when the same request arrives several times at once', async () => {
    // Repeated, with several requests each time, so they really overlap.
    for (let round = 0; round < 10; round++) {
      const body = request();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => imports.create(owner, body)),
      );
      expect(new Set(results.map((r) => r.import.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        await db.inventoryImport.count({
          where: { clientRequestId: body.clientRequestId },
        }),
      ).toBe(1);
      await db.inventoryImport.updateMany({
        where: { clientRequestId: body.clientRequestId },
        data: { status: 'CANCELLED' },
      });
    }
  });

  it('keeps one open import per organization, even for simultaneous requests', async () => {
    const results = await Promise.allSettled([
      imports.create(owner, request()),
      imports.create(northAdmin, request()),
    ]);
    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(
      ((refused[0].reason as HttpException).getResponse() as { code: string })
        .code,
    ).toBe('IMPORT_ACTIVE_EXISTS');

    const open = await db.inventoryImport.findFirstOrThrow({
      where: { status: 'RECEIVING' },
    });
    const creator = open.createdById === tenant.userId ? owner : northAdmin;
    const other = creator === owner ? northAdmin : owner;
    expect(await errorOf(imports.create(creator, request()))).toMatchObject({
      code: 'IMPORT_ACTIVE_EXISTS',
      importId: open.id,
    });
    expect(
      (await errorOf(imports.create(other, request()))).importId,
    ).toBeUndefined();
  });

  it('expires an import idle for 24 hours and deletes its staged data', async () => {
    const { import: idle } = await imports.create(owner, request());
    await db.inventoryImportBatch.create({
      data: {
        importId: idle.id,
        batchNumber: 1,
        payloadHash: 'a'.repeat(64),
        rowCount: 1,
        receivedRowsAfter: 1,
      },
    });
    await db.inventoryImportRow.create({
      data: { importId: idle.id, rowNumber: 2, batchNumber: 1, values: {} },
    });
    await db.inventoryImport.update({
      where: { id: idle.id },
      data: { lastActivityAt: new Date(Date.now() - 25 * 3_600_000) },
    });

    const read = await imports.get(owner, idle.id);

    expect(read).toMatchObject({ status: 'EXPIRED', expiresAt: null });
    expect(
      await db.inventoryImportRow.count({ where: { importId: idle.id } }),
    ).toBe(0);
    expect(
      await db.inventoryImportBatch.count({ where: { importId: idle.id } }),
    ).toBe(0);
    await expect(imports.create(owner, request())).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('cancels an open import once, deleting its staged rows', async () => {
    const { import: open } = await imports.create(northAdmin, request());
    await db.inventoryImportRow.create({
      data: { importId: open.id, rowNumber: 2, batchNumber: 1, values: {} },
    });

    expect((await errorOf(imports.cancel(owner, open.id))).code).toBe(
      'IMPORT_NOT_YOURS',
    );
    const cancelled = await imports.cancel(northAdmin, open.id);
    const again = await imports.cancel(northAdmin, open.id);

    expect(cancelled).toMatchObject({ status: 'CANCELLED', expiresAt: null });
    expect(again.status).toBe('CANCELLED');
    expect(
      await db.inventoryImportRow.count({ where: { importId: open.id } }),
    ).toBe(0);
  });

  it('does not cancel a completed import', async () => {
    const { import: done } = await imports.create(owner, request());
    await db.inventoryImport.update({
      where: { id: done.id },
      data: { status: 'COMPLETED' },
    });
    expect((await errorOf(imports.cancel(owner, done.id))).code).toBe(
      'IMPORT_CLOSED',
    );
  });

  it('hides imports from users who may not import in every warehouse they touch', async () => {
    const { import: mine } = await imports.create(owner, request());
    expect((await errorOf(imports.get(northAdmin, mine.id))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect((await errorOf(imports.cancel(northAdmin, mine.id))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect((await errorOf(imports.get(owner, 999_999))).code).toBe(
      'IMPORT_NOT_FOUND',
    );

    await db.inventoryImport.update({
      where: { id: mine.id },
      data: { summary: { warehouseIds: [north] } },
    });
    await expect(imports.get(northAdmin, mine.id)).resolves.toMatchObject({
      id: mine.id,
      summary: {},
    });
    await db.inventoryImport.update({
      where: { id: mine.id },
      data: { summary: { warehouseIds: [north, south] } },
    });
    expect((await errorOf(imports.get(northAdmin, mine.id))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
  });

  it('lists the imports each user may see, newest first', async () => {
    const all = await imports.list(owner, { pageSize: 100 });
    const own = await imports.list(northAdmin, { pageSize: 100 });
    const total = await db.inventoryImport.count();
    const admins = await db.inventoryImport.count({
      where: { createdById: northAdmin.user.id },
    });

    expect(all.total).toBe(total);
    expect(all.items.map((i) => i.id)).toEqual(
      [...all.items.map((i) => i.id)].sort((a, b) => b - a),
    );
    expect(own.items.every((i) => i.createdBy.id === northAdmin.user.id)).toBe(
      true,
    );
    expect(own.total).toBe(admins);
    expect(
      (
        await imports.list(owner, { status: 'COMPLETED', pageSize: 100 })
      ).items.map((i) => i.status),
    ).toEqual(expect.arrayContaining(['COMPLETED']));
  });
});
