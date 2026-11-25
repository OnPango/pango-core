import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
} from '../../src/generated/prisma/tenant/client.js';
import { MovementsService } from '../../src/movements/movements.service.js';
import {
  applyMigration,
  provisionTenant,
  tenantClient,
  type TestTenant,
} from './database.js';

const MIGRATION = '20261124200000_inventory_imports';

/** Postgres error code of a rejected statement (Prisma wraps it). */
async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const text = String((error as Error).message ?? error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') return '23505';
      if (error.code === 'P2003') return '23503';
    }
    const match = /23505|23514|23503/.exec(text);
    if (match) return match[0];
    throw error;
  }
  throw new Error('Expected the statement to be rejected');
}

function newImport(
  createdById: number,
  overrides: Partial<Prisma.InventoryImportUncheckedCreateInput> = {},
): Prisma.InventoryImportUncheckedCreateInput {
  return {
    clientRequestId: randomUUID(),
    createdById,
    schemaVersion: 1,
    fileName: 'inventario.xlsx',
    sheetName: 'Inventario',
    totalRows: 3,
    mapping: {},
    requestFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

/** A warehouse with its DEFAULT location and one product with stock 10 in it. */
async function seedStock(db: PrismaClient, tenant: TestTenant) {
  const unit = await db.unitOfMeasure.findUniqueOrThrow({
    where: { code: 'EA' },
  });
  const category = await db.category.create({ data: { name: 'Hardware' } });
  const product = await db.product.create({
    data: {
      sku: 'TOR-001',
      name: 'Bolt',
      categoryId: category.id,
      stockUnitId: unit.id,
    },
  });
  const created = await db.warehouse.create({
    data: { code: 'MAIN', name: 'Main' },
  });
  const location = await db.location.create({
    data: { warehouseId: created.id, code: 'DEFAULT' },
  });
  const warehouse = await db.warehouse.update({
    where: { id: created.id },
    data: { defaultLocationId: location.id },
  });
  const type = await db.movementType.findUniqueOrThrow({
    where: { name: 'Purchase receipt' },
  });
  const movements = new MovementsService({} as never, {} as never);
  await db.$transaction((tx) =>
    movements.record(tx, tenant.schema, {
      movementTypeId: type.id,
      registeredById: tenant.userId,
      warehouse,
      lines: [
        {
          lineNumber: 1,
          product: { id: product.id, sku: product.sku },
          effect: 'IN',
          quantity: new Prisma.Decimal(10),
          unitCost: new Prisma.Decimal(5),
        },
      ],
      allowNegative: false,
    }),
  );
  return { product, warehouse, type };
}

describe('inventory import staging tables', () => {
  let tenant: TestTenant;
  let db: PrismaClient;

  beforeAll(async () => {
    tenant = await provisionTenant('staging-new');
    db = tenantClient(tenant.schema);
  });
  afterAll(() => db.$disconnect());

  it('allows one open import per organization', async () => {
    const first = await db.inventoryImport.create({
      data: newImport(tenant.userId),
    });
    expect(
      await sqlState(
        db.inventoryImport.create({ data: newImport(tenant.userId) }),
      ),
    ).toBe('23505');

    for (const status of ['READY', 'INVALID'] as const) {
      await db.inventoryImport.update({
        where: { id: first.id },
        data: { status },
      });
      expect(
        await sqlState(
          db.inventoryImport.create({ data: newImport(tenant.userId) }),
        ),
      ).toBe('23505');
    }

    await db.inventoryImport.update({
      where: { id: first.id },
      data: { status: 'CANCELLED' },
    });
    const second = await db.inventoryImport.create({
      data: newImport(tenant.userId),
    });
    await db.inventoryImport.update({
      where: { id: second.id },
      data: { status: 'COMPLETED' },
    });
  });

  it('never reuses a client request id for the same user', async () => {
    const clientRequestId = randomUUID();
    const done = await db.inventoryImport.create({
      data: newImport(tenant.userId, { clientRequestId }),
    });
    await db.inventoryImport.update({
      where: { id: done.id },
      data: { status: 'EXPIRED' },
    });
    expect(
      await sqlState(
        db.inventoryImport.create({
          data: newImport(tenant.userId, { clientRequestId }),
        }),
      ),
    ).toBe('23505');
  });

  it('rejects impossible counts and row numbers', async () => {
    expect(
      await sqlState(
        db.inventoryImport.create({
          data: newImport(tenant.userId, { totalRows: 0, status: 'CANCELLED' }),
        }),
      ),
    ).toBe('23514');
    const open = await db.inventoryImport.create({
      data: newImport(tenant.userId, { totalRows: 3 }),
    });
    expect(
      await sqlState(
        db.inventoryImport.update({
          where: { id: open.id },
          data: { receivedRows: 4 },
        }),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        db.inventoryImportRow.create({
          data: { importId: open.id, rowNumber: 1, batchNumber: 1, values: {} },
        }),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        db.inventoryImportBatch.create({
          data: {
            importId: open.id,
            batchNumber: 1,
            payloadHash: 'b'.repeat(64),
            rowCount: 0,
            receivedRowsAfter: 0,
          },
        }),
      ),
    ).toBe('23514');
    await db.inventoryImport.update({
      where: { id: open.id },
      data: { status: 'CANCELLED' },
    });
  });

  it('deletes staged data with its import and keeps imports that created movements', async () => {
    const staged = await db.inventoryImport.create({
      data: {
        ...newImport(tenant.userId, { status: 'CANCELLED' }),
        batches: {
          create: {
            batchNumber: 1,
            payloadHash: 'c'.repeat(64),
            rowCount: 1,
            receivedRowsAfter: 1,
          },
        },
        rows: { create: { rowNumber: 2, batchNumber: 1, values: {} } },
        issues: {
          create: { severity: 'ERROR', code: 'REQUIRED_FIELD', message: 'x' },
        },
      },
    });
    await db.inventoryImport.delete({ where: { id: staged.id } });
    expect(
      await Promise.all([
        db.inventoryImportBatch.count({ where: { importId: staged.id } }),
        db.inventoryImportRow.count({ where: { importId: staged.id } }),
        db.inventoryImportIssue.count({ where: { importId: staged.id } }),
      ]),
    ).toEqual([0, 0, 0]);

    const { type } = await seedStock(db, tenant);
    const done = await db.inventoryImport.create({
      data: newImport(tenant.userId, { status: 'COMPLETED' }),
    });
    await db.movement.create({
      data: {
        number: 'MV-TEST-1',
        movementTypeId: type.id,
        registeredById: tenant.userId,
        status: 'CONFIRMED',
        inventoryImportId: done.id,
      },
    });
    expect(
      await sqlState(db.inventoryImport.delete({ where: { id: done.id } })),
    ).toBe('23503');
  });
});

describe('inventory import migration on an existing organization', () => {
  it('leaves existing stock and movements unchanged', async () => {
    const tenant = await provisionTenant('staging-existing', {
      before: MIGRATION,
    });
    const db = tenantClient(tenant.schema);
    try {
      // Seeded through raw SQL: the generated client already expects the new column.
      const unit = await db.$queryRawUnsafe<{ id: number }[]>(
        `SELECT "id" FROM "${tenant.schema}"."units_of_measure" WHERE "code" = 'EA'`,
      );
      const snapshot = async () =>
        db.$queryRawUnsafe<{ table: string; rows: string }[]>(
          `SELECT 'stock_balances' AS "table", COALESCE(json_agg(b ORDER BY b."id"), '[]')::text AS "rows" FROM "${tenant.schema}"."stock_balances" b
           UNION ALL
           SELECT 'movement_lines', COALESCE(json_agg(l ORDER BY l."movement_id", l."line_number"), '[]')::text FROM "${tenant.schema}"."movement_lines" l
           UNION ALL
           SELECT 'products', COALESCE(json_agg(p ORDER BY p."id"), '[]')::text FROM "${tenant.schema}"."products" p`,
        );
      await db.$executeRawUnsafe(
        `WITH c AS (INSERT INTO "${tenant.schema}"."categories" ("name") VALUES ('Hardware') RETURNING "id"),
              w AS (INSERT INTO "${tenant.schema}"."warehouses" ("code", "name") VALUES ('MAIN', 'Main') RETURNING "id"),
              l AS (INSERT INTO "${tenant.schema}"."locations" ("warehouse_id", "code") SELECT "id", 'DEFAULT' FROM w RETURNING "id", "warehouse_id"),
              p AS (INSERT INTO "${tenant.schema}"."products" ("sku", "name", "category_id", "stock_unit_id", "average_cost")
                    SELECT 'TOR-001', 'Bolt', c."id", $1, 5 FROM c RETURNING "id"),
              pw AS (INSERT INTO "${tenant.schema}"."product_warehouses" ("product_id", "warehouse_id")
                     SELECT p."id", l."warehouse_id" FROM p, l RETURNING "id")
         INSERT INTO "${tenant.schema}"."stock_balances" ("product_warehouse_id", "location_id", "quantity")
         SELECT pw."id", l."id", 10 FROM pw, l`,
        unit[0].id,
      );
      await db.$executeRawUnsafe(
        `WITH m AS (INSERT INTO "${tenant.schema}"."movements" ("number", "movement_type_id", "registered_by_id", "status")
                    SELECT 'MV-00000001', "id", $1, 'CONFIRMED' FROM "${tenant.schema}"."movement_types" WHERE "name" = 'Purchase receipt'
                    RETURNING "id")
         INSERT INTO "${tenant.schema}"."movement_lines" ("movement_id", "line_number", "product_id", "destination_location_id", "quantity", "unit_cost")
         SELECT m."id", 1, p."id", l."id", 10, 5 FROM m, "${tenant.schema}"."products" p, "${tenant.schema}"."locations" l`,
        tenant.userId,
      );
      const before = await snapshot();

      await applyMigration(tenant.schema, MIGRATION);

      expect(await snapshot()).toEqual(before);
      const movements = await db.movement.findMany({
        select: { inventoryImportId: true },
      });
      expect(movements).toEqual([{ inventoryImportId: null }]);
      expect(await db.inventoryImport.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
