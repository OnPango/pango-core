import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import pg from 'pg';
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
  type TestTenant,
} from './database.js';

const configWith = (values: Record<string, string> = {}) =>
  ({
    getOrThrow: () => testDatabaseUrl(),
    get: (name: string) => values[name],
  }) as unknown as ConfigService;

const mapping = {
  sku: { column: 1, header: 'a' },
  name: { column: 2, header: 'b' },
  category: { column: 3, header: 'c' },
  stockUnit: { column: 4, header: 'd' },
  warehouse: { column: 5, header: 'e' },
  tracksLots: { column: 6, header: 'f' },
  stockQuantity: { column: 7, header: 'g' },
};

const row = (sku: string) => ({
  sku,
  name: 'Producto',
  category: 'General',
  stockUnit: 'ud',
  warehouse: 'NORTE',
  tracksLots: 'Cantidad',
  stockQuantity: '5',
  unitCost: '2',
});

/** A running "server": its own Prisma clients and services. */
function server(values: Record<string, string> = {}) {
  const config = configWith(values);
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
    new MovementsService(control, tenants),
  );
  const stop = async () => {
    await tenants.onModuleDestroy();
    await control.$disconnect();
  };
  return { imports, stop };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return {
      status: http.getStatus(),
      ...(http.getResponse() as { code: string }),
    };
  }
  throw new Error('Expected the promise to reject');
}

describe('recovering from failures (INV-012)', () => {
  let tenant: TestTenant;
  let db: PrismaClient;
  let owner: AuthContext;
  let product: { id: number };
  let other: { id: number };
  const main = server();

  beforeAll(async () => {
    tenant = await provisionTenant('recovery');
    db = tenantClient(tenant.schema);
    await createWarehouse(db, 'NORTE');
    owner = await sessionFor(db, tenant, tenant.userId);
    const unit = await db.unitOfMeasure.findUniqueOrThrow({
      where: { code: 'EA' },
    });
    const category = await db.category.create({ data: { name: 'General' } });
    product = await db.product.create({
      data: {
        sku: 'HELD-1',
        name: 'Producto',
        categoryId: category.id,
        stockUnitId: unit.id,
      },
    });
    other = await db.product.create({
      data: {
        sku: 'HELD-2',
        name: 'Producto',
        categoryId: category.id,
        stockUnitId: unit.id,
      },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await main.stop();
  });

  /** Starts, fills and validates an import with `main`. */
  async function readyImport(rows: Record<string, string>[]) {
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
    const { import: record } = await main.imports.create(owner, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'f.xlsx',
      sheetName: 'Inventario',
      totalRows: rows.length,
      mapping,
    });
    await main.imports.appendRows(owner, record.id, {
      batchNumber: 1,
      rows: rows.map((values, i) => ({ rowNumber: i + 2, values })),
    });
    const report = await main.imports.validate(owner, record.id);
    return { id: record.id, revision: report.import.revision };
  }

  /**
   * Another connection takes the product's row lock and keeps it for `ms`.
   * Resolves once the lock is held; `released` resolves when it is let go.
   */
  async function holdProduct(productId: number, ms: number) {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `SELECT 1 FROM "${tenant.schema}"."products" WHERE "id" = $1 FOR UPDATE`,
      [productId],
    );
    const released = (async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await client.query('ROLLBACK');
      await client.end();
    })();
    return { released };
  }

  const writes = () =>
    Promise.all([
      db.movement.count(),
      db.stockBalance.count(),
      db.product.count(),
    ]);

  it('gives up a long lock wait in time, writes nothing, and confirms on retry', async () => {
    const { id, revision } = await readyImport([row('HELD-1')]);
    const quick = server({ INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS: '800' });
    const before = await writes();
    const { released } = await holdProduct(product.id, 3000);
    const started = Date.now();

    const failure = await errorOf(
      quick.imports.confirm(owner, id, { revision }),
    );

    // PostgreSQL itself cancelled the wait: the request does not hang.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(failure).toMatchObject({ status: 503, code: 'IMPORT_BUSY' });
    await released;
    await quick.stop();
    expect(await writes()).toEqual(before);
    expect(
      await db.inventoryImport.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'READY',
    });
    await expect(
      main.imports.confirm(owner, id, { revision }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
    });
  });

  it('survives a connection cut in the middle of a confirmation', async () => {
    const { id, revision } = await readyImport([row('CUT-1'), row('HELD-2')]);
    const before = await writes();
    const { released } = await holdProduct(other.id, 4000);

    const pending = errorOf(main.imports.confirm(owner, id, { revision }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const killer = new pg.Client({ connectionString: testDatabaseUrl() });
    await killer.connect();
    const killed = await killer.query(
      `SELECT pg_terminate_backend("pid") FROM pg_stat_activity
        WHERE "wait_event_type" = 'Lock' AND "datname" = current_database()
          AND "pid" <> pg_backend_pid()`,
    );
    await killer.end();

    expect(killed.rowCount).toBe(1);
    expect(await pending).toMatchObject({ status: 503, code: 'IMPORT_BUSY' });
    await released;
    expect(await writes()).toEqual(before);
    expect(await db.product.count({ where: { sku: 'CUT-1' } })).toBe(0);
    await expect(
      main.imports.confirm(owner, id, { revision }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(await db.product.count({ where: { sku: 'CUT-1' } })).toBe(1);
  });

  it('continues an import after a restart: nothing lives in memory', async () => {
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
    const before = server();
    const clientRequestId = randomUUID();
    const body = {
      clientRequestId,
      schemaVersion: 1,
      fileName: 'f.xlsx',
      sheetName: 'Inventario',
      totalRows: 2,
      mapping,
    };
    const { import: record } = await before.imports.create(owner, body);
    await before.imports.appendRows(owner, record.id, {
      batchNumber: 1,
      rows: [{ rowNumber: 2, values: row('RESTART-1') }],
    });
    await before.stop();

    const after = server();
    // The lost answers of the first server are recovered by retrying.
    await expect(after.imports.create(owner, body)).resolves.toMatchObject({
      replayed: true,
      import: { id: record.id, receivedRows: 1 },
    });
    await expect(
      after.imports.appendRows(owner, record.id, {
        batchNumber: 1,
        rows: [{ rowNumber: 2, values: row('RESTART-1') }],
      }),
    ).resolves.toMatchObject({ replayed: true, receivedRows: 1 });
    await after.imports.appendRows(owner, record.id, {
      batchNumber: 2,
      rows: [{ rowNumber: 3, values: row('RESTART-2') }],
    });
    const report = await after.imports.validate(owner, record.id);
    await expect(
      after.imports.confirm(owner, record.id, {
        revision: report.import.revision,
      }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
    await after.stop();
  });

  it('recovers a lost validation answer by reading the current revision', async () => {
    const { id, revision } = await readyImport([row('LOST-1')]);
    // The answer of a second validation is lost: the client still holds the first.
    await main.imports.validate(owner, id);

    expect(
      await errorOf(main.imports.confirm(owner, id, { revision })),
    ).toMatchObject({
      status: 409,
      code: 'IMPORT_STALE',
    });
    const current = await main.imports.get(owner, id);
    expect(current.revision).toBe(revision + 1);
    await expect(
      main.imports.confirm(owner, id, { revision: current.revision }),
    ).resolves.toMatchObject({ status: 'COMPLETED' });
  });
});
