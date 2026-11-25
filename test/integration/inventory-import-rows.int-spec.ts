import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../../src/auth/auth-context.js';
import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import type { AppendInventoryRowsDto } from '../../src/inventory-imports/dto.js';
import { InventoryImportConfig } from '../../src/inventory-imports/inventory-import-config.js';
import { InventoryImportsService } from '../../src/inventory-imports/inventory-imports.service.js';
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

const configWith = (values: Record<string, string> = {}) =>
  ({
    getOrThrow: () => testDatabaseUrl(),
    get: (name: string) => values[name],
  }) as unknown as ConfigService;

const mapping = {
  sku: { column: 1, header: 'Código producto *' },
  name: { column: 2, header: 'Producto *' },
  category: { column: 3, header: 'Categoría *' },
  stockUnit: { column: 4, header: 'Unidad de medida *' },
  warehouse: { column: 5, header: 'Bodega *' },
  tracksLots: { column: 6, header: 'Seguimiento *' },
  stockQuantity: { column: 7, header: 'Saldo inicial *' },
};

/** Rows `from`..`to` of a file, one product each. */
function rows(from: number, to: number, quantity = '5') {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    rowNumber: from + i,
    values: {
      sku: `SKU-${from + i}`,
      name: `Product ${from + i}`,
      category: 'Hardware',
      stockUnit: 'ud',
      warehouse: 'NORTH',
      tracksLots: 'Cantidad',
      stockQuantity: quantity,
    },
  }));
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as { code: string };
  }
  throw new Error('Expected the promise to reject');
}

describe('receiving batches of rows', () => {
  const config = configWith();
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
  );
  let tenant: TestTenant;
  let db: PrismaClient;
  let owner: AuthContext;
  let admin: AuthContext;

  /** An open import of `totalRows` rows started by the Owner. */
  async function start(totalRows: number) {
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
    const { import: record } = await imports.create(owner, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'inventario.xlsx',
      sheetName: 'Inventario',
      totalRows,
      mapping,
    });
    return record.id;
  }

  const send = (
    auth: AuthContext,
    id: number,
    batchNumber: number,
    batch: AppendInventoryRowsDto['rows'],
  ) => imports.appendRows(auth, id, { batchNumber, rows: batch });

  beforeAll(async () => {
    tenant = await provisionTenant('rows');
    db = tenantClient(tenant.schema);
    const north = await createWarehouse(db, 'NORTH');
    owner = await sessionFor(db, tenant, tenant.userId);
    admin = await sessionFor(
      db,
      tenant,
      (await createUser(db, 902, 'Admin', [north.id])).id,
    );
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
    await control.$disconnect();
  });

  it('stores batches in any order until every declared row arrived', async () => {
    const id = await start(5);

    const second = await send(owner, id, 2, rows(5, 6));
    const first = await send(owner, id, 1, rows(2, 4));

    expect(second).toEqual({
      importId: id,
      batchNumber: 2,
      acceptedRows: 2,
      receivedRows: 2,
      totalRows: 5,
      status: 'RECEIVING',
      replayed: false,
    });
    expect(first).toMatchObject({ acceptedRows: 3, receivedRows: 5 });
    const stored = await db.inventoryImportRow.findMany({
      where: { importId: id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(stored.map((r) => [r.rowNumber, r.batchNumber, r.status])).toEqual([
      [2, 1, 'PENDING'],
      [3, 1, 'PENDING'],
      [4, 1, 'PENDING'],
      [5, 2, 'PENDING'],
      [6, 2, 'PENDING'],
    ]);
    expect(stored[0].values).toEqual(rows(2, 2)[0].values);
    expect(
      (await db.inventoryImport.findUniqueOrThrow({ where: { id } }))
        .receivedRows,
    ).toBe(5);
  });

  it('answers a retried batch as the first time, changing nothing', async () => {
    const id = await start(4);
    const first = await send(owner, id, 1, rows(2, 3));
    await send(owner, id, 2, rows(4, 5));

    const retried = await send(owner, id, 1, [...rows(2, 3)].reverse());

    expect(retried).toEqual({ ...first, replayed: true });
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      4,
    );
    expect(
      (await db.inventoryImport.findUniqueOrThrow({ where: { id } }))
        .receivedRows,
    ).toBe(4);
  });

  it('refuses other rows under a received batch number or a received row', async () => {
    const id = await start(10);
    await send(owner, id, 1, rows(2, 3));

    expect((await errorOf(send(owner, id, 1, rows(2, 3, '9')))).code).toBe(
      'BATCH_CONFLICT',
    );
    expect((await errorOf(send(owner, id, 2, rows(3, 4)))).code).toBe(
      'BATCH_CONFLICT',
    );
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      2,
    );
    expect(
      await db.inventoryImportBatch.count({ where: { importId: id } }),
    ).toBe(1);
  });

  it('refuses more rows than declared, storing none of the batch', async () => {
    const id = await start(3);
    await send(owner, id, 1, rows(2, 3));

    expect((await errorOf(send(owner, id, 2, rows(4, 5)))).code).toBe(
      'ROWS_EXCEED_TOTAL',
    );
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      2,
    );
  });

  it('stores a batch once when it arrives several times at once', async () => {
    const id = await start(100);
    const batch = rows(2, 41);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(owner, id, 1, batch)),
    );

    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.receivedRows))).toEqual(new Set([40]));
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      40,
    );
  });

  it('stores different batches arriving at once without losing any', async () => {
    const id = await start(60);

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        send(owner, id, i + 1, rows(2 + i * 10, 11 + i * 10)),
      ),
    );

    const record = await db.inventoryImport.findUniqueOrThrow({
      where: { id },
    });
    expect(record.receivedRows).toBe(60);
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      60,
    );
    const batches = await db.inventoryImportBatch.findMany({
      where: { importId: id },
    });
    expect(
      batches.map((b) => b.receivedRowsAfter).sort((a, b) => a - b),
    ).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('takes rows only while receiving, but still answers a retried batch', async () => {
    const id = await start(4);
    const first = await send(owner, id, 1, rows(2, 3));
    await db.inventoryImport.update({
      where: { id },
      data: { status: 'READY' },
    });

    expect((await errorOf(send(owner, id, 2, rows(4, 5)))).code).toBe(
      'IMPORT_NOT_RECEIVING',
    );
    await expect(send(owner, id, 1, rows(2, 3))).resolves.toEqual({
      ...first,
      status: 'READY',
      replayed: true,
    });

    await imports.cancel(owner, id);
    expect((await errorOf(send(owner, id, 1, rows(2, 3)))).code).toBe(
      'IMPORT_CLOSED',
    );
  });

  it('lets only the creator send rows and records the activity', async () => {
    const id = await start(4);
    const before = await db.inventoryImport.findUniqueOrThrow({
      where: { id },
    });

    expect((await errorOf(send(admin, id, 1, rows(2, 3)))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
    await send(owner, id, 1, rows(2, 3));

    const after = await db.inventoryImport.findUniqueOrThrow({ where: { id } });
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(
      before.lastActivityAt.getTime(),
    );
  });

  it('refuses a batch larger than the configured limit', async () => {
    const small = configWith({ INVENTORY_IMPORT_MAX_BATCH_ROWS: '3' });
    const limited = new InventoryImportsService(
      tenants,
      control,
      new InventoryImportConfig(small),
    );
    const id = await start(10);

    expect(
      (
        await errorOf(
          limited.appendRows(owner, id, { batchNumber: 1, rows: rows(2, 5) }),
        )
      ).code,
    ).toBe('IMPORT_LIMIT_EXCEEDED');
    expect(
      (await errorOf(send(owner, id, 1, [{ rowNumber: 1, values: {} }]))).code,
    ).toBe('ROWS_INVALID');
    expect(await db.inventoryImportRow.count({ where: { importId: id } })).toBe(
      0,
    );
  });
});
