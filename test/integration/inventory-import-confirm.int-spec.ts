import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../../src/auth/auth-context.js';
import { demandCondition } from '../../src/demand/demand-rule.js';
import {
  Prisma,
  type PrismaClient,
} from '../../src/generated/prisma/tenant/client.js';
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

const mapping = {
  sku: { column: 1, header: 'Código producto *' },
  name: { column: 2, header: 'Producto *' },
  category: { column: 3, header: 'Categoría *' },
  stockUnit: { column: 4, header: 'Unidad de medida *' },
  warehouse: { column: 5, header: 'Bodega *' },
  tracksLots: { column: 6, header: 'Seguimiento *' },
  stockQuantity: { column: 7, header: 'Saldo inicial *' },
  unitCost: { column: 8, header: 'Costo unitario' },
  lotCode: { column: 9, header: 'Código de lote **' },
  locationCode: { column: 10, header: 'Ubicación' },
  expiryDate: { column: 12, header: 'Fecha vencimiento' },
  warehouseCode: { column: 14, header: 'Código de bodega' },
};

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse?.() as { code: string };
  }
  throw new Error('Expected the promise to reject');
}

/** A tenant with Norte (location A-01) and Sur, a bolt with 50 at 10 in Norte, an oil tracked by lot. */
async function setup(subdomain: string) {
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const movements = new MovementsService(control, tenants);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
    movements,
  );
  const tenant = await provisionTenant(subdomain);
  const db = tenantClient(tenant.schema);
  const north = await db.warehouse.update({
    where: { id: (await createWarehouse(db, 'NORTE')).id },
    data: { name: 'Norte' },
  });
  const south = await db.warehouse.update({
    where: { id: (await createWarehouse(db, 'SUR')).id },
    data: { name: 'Sur' },
  });
  const shelf = await db.location.create({
    data: { warehouseId: north.id, code: 'A-01' },
  });
  const [ea, ltr] = await Promise.all([
    db.unitOfMeasure.findUniqueOrThrow({ where: { code: 'EA' } }),
    db.unitOfMeasure.findUniqueOrThrow({ where: { code: 'LTR' } }),
  ]);
  const tools = await db.category.create({ data: { name: 'Herramientas' } });
  const bolt = await db.product.create({
    data: {
      sku: 'TOR-001',
      name: 'Tornillo',
      categoryId: tools.id,
      stockUnitId: ea.id,
    },
  });
  const oil = await db.product.create({
    data: {
      sku: 'ACE-001',
      name: 'Aceite',
      categoryId: tools.id,
      stockUnitId: ltr.id,
      tracksLots: true,
    },
  });
  const owner = await sessionFor(db, tenant, tenant.userId);
  const northAdmin = await sessionFor(
    db,
    tenant,
    (await createUser(db, 906, 'Admin', [north.id])).id,
  );

  /** An inbound movement, as `POST /movements` records it. */
  async function receive(
    product: { id: number; sku: string },
    quantity: number,
    unitCost: number,
    locationId?: number,
    lotCode?: string,
  ) {
    const type = await db.movementType.findUniqueOrThrow({
      where: { name: 'Purchase receipt' },
    });
    await db.$transaction((tx) =>
      movements.record(tx, tenant.schema, {
        movementTypeId: type.id,
        registeredById: tenant.userId,
        warehouse: north,
        lines: [
          {
            lineNumber: 1,
            product,
            effect: 'IN',
            quantity: new Prisma.Decimal(quantity),
            unitCost: new Prisma.Decimal(unitCost),
            locationId,
            lotCode,
          },
        ],
        allowNegative: false,
      }),
    );
  }

  /** Starts, fills and validates an import of these rows (row 2 onwards). */
  async function staged(auth: AuthContext, rows: Record<string, string>[]) {
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
    const { import: record } = await imports.create(auth, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'inventario.xlsx',
      sheetName: 'Inventario',
      totalRows: rows.length,
      mapping,
    });
    await imports.appendRows(auth, record.id, {
      batchNumber: 1,
      rows: rows.map((values, i) => ({ rowNumber: i + 2, values })),
    });
    const report = await imports.validate(auth, record.id);
    return {
      id: record.id,
      revision: report.import.revision,
      status: report.import.status,
    };
  }

  const close = async () => {
    await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
    await control.$disconnect();
  };

  return {
    tenant,
    db,
    imports,
    movements,
    north,
    south,
    shelf,
    bolt,
    oil,
    tools,
    owner,
    northAdmin,
    receive,
    staged,
    close,
  };
}

const row = (values: Record<string, string>) => ({
  sku: 'TOR-001',
  name: 'Tornillo',
  category: 'Herramientas',
  stockUnit: 'ud',
  warehouse: 'Norte',
  tracksLots: 'Cantidad',
  stockQuantity: '10',
  unitCost: '5',
  ...values,
});
const oilRow = (values: Record<string, string>) =>
  row({
    sku: 'ACE-001',
    name: 'Aceite',
    stockUnit: 'litro',
    tracksLots: 'Lote',
    ...values,
  });

/** Quantity of a product at a location and lot. */
async function balance(
  db: PrismaClient,
  productId: number,
  locationId: number,
  lotId: number | null = null,
) {
  const found = await db.stockBalance.findFirst({
    where: { locationId, lotId, productWarehouse: { productId } },
  });
  return found?.quantity.toString() ?? null;
}

describe('confirming an inventory import', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    t = await setup('confirm');
    await t.receive(t.bolt, 50, 10); // 50 at 10 in Norte's DEFAULT
  });
  afterAll(() => t.close());

  it('writes the whole plan through the movement engine', async () => {
    const { id, revision, status } = await t.staged(t.owner, [
      row({ locationCode: 'A-01', stockQuantity: '30', unitCost: '20' }), // 2
      row({
        sku: 'NEW-1',
        name: 'Taladro',
        category: 'Eléctricas',
        warehouse: 'Oeste',
        warehouseCode: 'OES',
        stockQuantity: '5',
        unitCost: '100',
      }), // 3
      oilRow({
        lotCode: 'L-9',
        stockQuantity: '12',
        unitCost: '8',
        expiryDate: '2027-01-01',
      }), // 4
      row({ sku: 'NEW-2', name: 'Broca', stockQuantity: '0' }), // 5
      row({
        sku: 'NEW-1',
        name: 'Taladro',
        category: 'Eléctricas',
        stockQuantity: '7',
        unitCost: '',
      }), // 6
    ]);
    expect(status).toBe('READY');

    const confirmed = await t.imports.confirm(t.owner, id, { revision });

    expect(confirmed).toMatchObject({
      status: 'COMPLETED',
      result: {
        stockRows: 4,
        movements: 3,
        created: { categories: 1, products: 2, warehouses: 1, lots: 1 },
        assignedWarehouses: 0,
      },
    });
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(
      await t.db.inventoryImportRow.count({ where: { importId: id } }),
    ).toBe(0);

    const db = t.db;
    const [newProduct, zeroProduct, lot, west, electric] = await Promise.all([
      db.product.findUniqueOrThrow({ where: { sku: 'NEW-1' } }),
      db.product.findUniqueOrThrow({
        where: { sku: 'NEW-2' },
        include: { warehouses: true },
      }),
      db.lot.findFirstOrThrow({ where: { productId: t.oil.id, code: 'L-9' } }),
      db.warehouse.findUniqueOrThrow({ where: { code: 'OES' } }),
      db.category.findFirstOrThrow({ where: { name: 'Eléctricas' } }),
    ]);
    // Balances where the file put them; the earlier stock is untouched.
    expect(await balance(db, t.bolt.id, t.shelf.id)).toBe('30');
    expect(await balance(db, t.bolt.id, t.north.defaultLocationId!)).toBe('50');
    expect(await balance(db, newProduct.id, west.defaultLocationId!)).toBe('5');
    expect(await balance(db, newProduct.id, t.north.defaultLocationId!)).toBe(
      '7',
    );
    expect(
      await balance(db, t.oil.id, t.north.defaultLocationId!, lot.id),
    ).toBe('12');
    expect(zeroProduct.warehouses).toEqual([]);
    expect(lot.expiryDate?.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(west).toMatchObject({
      name: 'Oeste',
      type: 'WAREHOUSE',
      holdsStock: true,
    });
    expect(electric.parentId).toBeNull();
    expect(newProduct.categoryId).toBe(electric.id);
    expect(zeroProduct.categoryId).toBe(t.tools.id);

    // Weighted average costs (INV-BR-13): 50 at 10 + 30 at 20 = 13.75; the
    // line without cost takes the 100 the file's own cost set (INV-BR-01).
    const costs = await db.product.findMany({
      where: { sku: { in: ['TOR-001', 'NEW-1', 'ACE-001', 'NEW-2'] } },
      select: { sku: true, averageCost: true },
    });
    expect(
      Object.fromEntries(costs.map((c) => [c.sku, c.averageCost.toString()])),
    ).toEqual({
      'TOR-001': '13.75',
      'NEW-1': '100',
      'ACE-001': '8',
      'NEW-2': '0',
    });

    // Opening balance movements linked to the import, registered by the user.
    const opening = await db.movement.findMany({
      where: { inventoryImportId: id },
      include: { movementType: true, lines: true },
    });
    expect(opening).toHaveLength(3);
    for (const movement of opening) {
      expect(movement).toMatchObject({
        status: 'CONFIRMED',
        documentRef: `INV-IMP-${id}`,
        registeredById: t.tenant.userId,
        movementType: { name: 'Opening balance', countsAsDemand: false },
      });
    }
    expect(opening.flatMap((m) => m.lines)).toHaveLength(4);

    // No artificial demand (INV-FR-08): the shared demand rule finds nothing.
    const [{ demand }] = await db.$queryRawUnsafe<{ demand: number }[]>(
      `SELECT COUNT(*)::int AS "demand"
         FROM "${t.tenant.schema}"."movement_lines" l
         JOIN "${t.tenant.schema}"."movements" m ON m."id" = l."movement_id"
         JOIN "${t.tenant.schema}"."movement_types" t ON t."id" = m."movement_type_id"
        WHERE ${demandCondition()}`,
    );
    expect(demand).toBe(0);

    // Confirming again answers the same result and writes nothing.
    const again = await t.imports.confirm(t.owner, id, { revision });
    expect(again.result).toEqual(confirmed.result);
    expect(await db.movement.count({ where: { inventoryImportId: id } })).toBe(
      3,
    );
  });

  it('refuses a stale preview and writes nothing', async () => {
    const { id, revision } = await t.staged(t.owner, [
      oilRow({ lotCode: 'L-20', locationCode: 'A-01', stockQuantity: '4' }),
      row({ sku: 'NEW-3', name: 'Lija', stockQuantity: '2' }),
    ]);
    expect(
      (
        await errorOf(
          t.imports.confirm(t.owner, id, { revision: revision + 1 }),
        )
      ).code,
    ).toBe('IMPORT_STALE');

    // Someone receives the same oil lot on A-01 after the preview.
    await t.receive(t.oil, 1, 9, t.shelf.id, 'L-20');
    const products = await t.db.product.count();
    const movements = await t.db.movement.count();

    expect(
      (await errorOf(t.imports.confirm(t.owner, id, { revision }))).code,
    ).toBe('IMPORT_STALE');
    expect(await t.db.product.count()).toBe(products);
    expect(await t.db.movement.count()).toBe(movements);
    expect(
      await t.db.inventoryImport.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'READY',
      revision,
    });
    const revalidated = await t.imports.validate(t.owner, id);
    expect(revalidated.import.status).toBe('INVALID');
  });

  it('confirms only a READY import', async () => {
    const invalid = await t.staged(t.owner, [row({ stockUnit: 'cm' })]);
    expect(
      (await errorOf(t.imports.confirm(t.owner, invalid.id, { revision: 1 })))
        .code,
    ).toBe('IMPORT_NOT_READY');
    await t.imports.cancel(t.owner, invalid.id);
    expect(
      (await errorOf(t.imports.confirm(t.owner, invalid.id, { revision: 1 })))
        .code,
    ).toBe('IMPORT_CLOSED');
    const ready = await t.staged(t.owner, [
      row({ sku: 'NEW-4', name: 'Clavo' }),
    ]);
    expect(
      (
        await errorOf(
          t.imports.confirm(t.northAdmin, ready.id, { revision: 1 }),
        )
      ).code,
    ).toBe('IMPORT_NOT_YOURS');
  });

  it('assigns a non-Owner to the warehouse their import creates', async () => {
    const { id, revision } = await t.staged(t.northAdmin, [
      row({
        sku: 'NEW-5',
        name: 'Martillo',
        warehouse: 'Este',
        warehouseCode: 'EST',
      }),
      row({ sku: 'NEW-5', name: 'Martillo', stockQuantity: '3' }),
    ]);

    const confirmed = await t.imports.confirm(t.northAdmin, id, { revision });

    expect(confirmed.result).toMatchObject({
      assignedWarehouses: 1,
      created: { warehouses: 1 },
    });
    const east = await t.db.warehouse.findUniqueOrThrow({
      where: { code: 'EST' },
    });
    const assignments = await t.db.roleAssignment.findMany({
      where: { userId: t.northAdmin.user.id, warehouseId: east.id },
      include: { role: true },
    });
    expect(assignments.map((a) => a.role.name)).toEqual(['Admin']);
  });

  it('raises the alerts of a product-warehouse below its reorder point', async () => {
    const pw = await t.db.productWarehouse.create({
      data: {
        productId: t.oil.id,
        warehouseId: t.south.id,
        reorderPoint: 100,
        manualReorderPoint: 100,
      },
    });
    const { id, revision } = await t.staged(t.owner, [
      oilRow({ lotCode: 'L-30', warehouse: 'Sur', stockQuantity: '10' }),
    ]);

    await t.imports.confirm(t.owner, id, { revision });

    expect(
      await t.db.alert.findFirst({
        where: { productWarehouseId: pw.id, status: 'OPEN' },
      }),
    ).toMatchObject({
      type: 'BELOW_ROP',
      availableQuantity: new Prisma.Decimal(10),
    });
  });
});

describe('a failing confirmation leaves nothing behind (INV-FR-03)', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    t = await setup('confirm-faults');
    await t.db.$executeRawUnsafe(
      `CREATE FUNCTION "${t.tenant.schema}"."inject_failure"() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
    );
  });
  afterAll(() => t.close());

  /** Everything a confirmation can write. */
  async function snapshot() {
    const s = t.tenant.schema;
    const [row] = await t.db.$queryRawUnsafe<Record<string, string>[]>(
      `SELECT (SELECT COUNT(*) FROM "${s}"."categories")::text AS "categories",
              (SELECT COUNT(*) FROM "${s}"."warehouses")::text AS "warehouses",
              (SELECT COUNT(*) FROM "${s}"."locations")::text AS "locations",
              (SELECT COUNT(*) FROM "${s}"."products")::text AS "products",
              (SELECT string_agg("sku" || '=' || "average_cost"::text, ',' ORDER BY "id") FROM "${s}"."products") AS "costs",
              (SELECT COUNT(*) FROM "${s}"."lots")::text AS "lots",
              (SELECT COUNT(*) FROM "${s}"."product_warehouses")::text AS "productWarehouses",
              (SELECT COALESCE(SUM("quantity"), 0)::text || '/' || COUNT(*) FROM "${s}"."stock_balances") AS "balances",
              (SELECT COUNT(*) FROM "${s}"."movements")::text AS "movements",
              (SELECT COUNT(*) FROM "${s}"."movement_lines")::text AS "lines",
              (SELECT COUNT(*) FROM "${s}"."alerts")::text AS "alerts",
              (SELECT COUNT(*) FROM "${s}"."role_assignments")::text AS "assignments"`,
    );
    return row;
  }

  it.each([
    ['category creation', 'categories', 'INSERT'],
    ['warehouse creation', 'warehouses', 'INSERT'],
    ['default location creation', 'locations', 'INSERT'],
    ['role assignment', 'role_assignments', 'INSERT'],
    ['product creation', 'products', 'INSERT'],
    ['lot creation', 'lots', 'INSERT'],
    ['product-warehouse creation', 'product_warehouses', 'INSERT'],
    ['stock registration', 'stock_balances', 'INSERT'],
    ['average cost calculation', 'products', 'UPDATE'],
    ['movement creation', 'movements', 'INSERT'],
    ['alert evaluation', 'alerts', 'INSERT OR UPDATE'],
    ['completion of the import', 'inventory_imports', 'UPDATE'],
  ])('rolls back a failure during %s', async (_step, table, event) => {
    // One import touches every step: a new category, warehouse (with the
    // creator's assignment), product and lot, stock with cost, and an alert.
    await t.db.productWarehouse.upsert({
      where: {
        productId_warehouseId: { productId: t.oil.id, warehouseId: t.north.id },
      },
      create: {
        productId: t.oil.id,
        warehouseId: t.north.id,
        reorderPoint: 1000,
        manualReorderPoint: 1000,
      },
      update: {},
    });
    const { id, revision, status } = await t.staged(t.northAdmin, [
      row({
        sku: `NEW-${table}-${event}`,
        name: 'Nuevo',
        category: 'Nueva categoría',
        warehouse: `W ${table} ${event}`,
        warehouseCode: `W-${table.slice(0, 8)}-${event[0]}`,
        stockQuantity: '4',
        unitCost: '3',
      }),
      oilRow({
        lotCode: `L-${table}-${event}`,
        stockQuantity: '6',
        unitCost: '2',
      }),
    ]);
    expect(status).toBe('READY');
    const before = await snapshot();
    const when =
      table === 'inventory_imports' ? `WHEN (NEW."status" = 'COMPLETED')` : '';
    await t.db.$executeRawUnsafe(
      `CREATE TRIGGER "inject" BEFORE ${event} ON "${t.tenant.schema}"."${table}"
         FOR EACH ROW ${when} EXECUTE FUNCTION "${t.tenant.schema}"."inject_failure"()`,
    );
    try {
      await expect(
        t.imports.confirm(t.northAdmin, id, { revision }),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await t.db.$executeRawUnsafe(
        `DROP TRIGGER "inject" ON "${t.tenant.schema}"."${table}"`,
      );
    }

    expect(await snapshot()).toEqual(before);
    expect(
      await t.db.inventoryImport.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'READY',
      revision,
    });
    expect(
      await t.db.inventoryImportRow.count({ where: { importId: id } }),
    ).toBe(2);
    // The same import confirms once the failure is gone.
    await expect(
      t.imports.confirm(t.northAdmin, id, { revision }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
    });
  });
});

describe('confirmations alongside other operations (INV-TD-02)', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    t = await setup('confirm-race');
  });
  afterAll(() => t.close());

  it('waits for an operation holding the product, then sees what it did', async () => {
    const lot = 'HELD-1';
    const { id, revision } = await t.staged(t.owner, [
      oilRow({ lotCode: lot, locationCode: 'A-01', stockQuantity: '10' }),
    ]);
    const type = await t.db.movementType.findUniqueOrThrow({
      where: { name: 'Purchase receipt' },
    });
    let confirmation: Promise<unknown> | undefined;

    // A purchase holds the oil's row lock while the confirmation starts.
    await t.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT 1 FROM "${t.tenant.schema}"."products" WHERE "id" = $1 FOR UPDATE`,
          t.oil.id,
        );
        confirmation = t.imports
          .confirm(t.owner, id, { revision })
          .catch((error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await t.movements.record(tx, t.tenant.schema, {
          movementTypeId: type.id,
          registeredById: t.tenant.userId,
          warehouse: t.north,
          lines: [
            {
              lineNumber: 1,
              product: t.oil,
              effect: 'IN',
              quantity: new Prisma.Decimal(3),
              unitCost: new Prisma.Decimal(4),
              locationId: t.shelf.id,
              lotCode: lot,
            },
          ],
          allowNegative: false,
        });
      },
      { timeout: 20_000 },
    );

    // It must have waited before validating, so it sees the purchase.
    const outcome = (await confirmation) as HttpException;
    expect((outcome.getResponse() as { code: string }).code).toBe(
      'IMPORT_STALE',
    );
    const stored = await t.db.lot.findFirstOrThrow({
      where: { productId: t.oil.id, code: lot },
    });
    expect(await balance(t.db, t.oil.id, t.shelf.id, stored.id)).toBe('3');
    expect(
      await t.db.movement.count({ where: { inventoryImportId: id } }),
    ).toBe(0);
  });

  it('applies one of two simultaneous confirmations, and both answer its result', async () => {
    const { id, revision } = await t.staged(t.owner, [
      row({ sku: 'RACE-1', name: 'Uno', stockQuantity: '8' }),
    ]);
    const [a, b] = await Promise.all([
      t.imports.confirm(t.owner, id, { revision }),
      t.imports.confirm(t.owner, id, { revision }),
    ]);
    expect(a.result).toEqual(b.result);
    expect(
      await t.db.movement.count({ where: { inventoryImportId: id } }),
    ).toBe(1);
    expect(await t.db.product.count({ where: { sku: 'RACE-1' } })).toBe(1);
  });

  it('never loses stock when a purchase of the same product races the confirmation', async () => {
    for (let round = 0; round < 10; round++) {
      const lot = `R-${round}`;
      const { id, revision } = await t.staged(t.owner, [
        oilRow({ lotCode: lot, locationCode: 'A-01', stockQuantity: '10' }),
      ]);
      const [confirmation, purchase] = await Promise.allSettled([
        t.imports.confirm(t.owner, id, { revision }),
        t.receive(t.oil, 3, 4, t.shelf.id, lot),
      ]);
      expect(purchase.status).toBe('fulfilled');
      const stored = await t.db.lot.findFirstOrThrow({
        where: { productId: t.oil.id, code: lot },
      });
      const quantity = await balance(t.db, t.oil.id, t.shelf.id, stored.id);
      if (confirmation.status === 'fulfilled') {
        // The purchase waited for the opening and added on top of it: the
        // opening was recorded first, on a lot that had nothing.
        expect(quantity).toBe('13');
        const lines = await t.db.movementLine.findMany({
          where: { productId: t.oil.id, lotId: stored.id },
          include: { movement: { select: { inventoryImportId: true } } },
          orderBy: { movementId: 'asc' },
        });
        expect(lines.map((l) => l.movement.inventoryImportId)).toEqual([
          id,
          null,
        ]);
      } else {
        // The purchase came first: the opening is stale and loads nothing.
        expect(
          (
            (confirmation.reason as HttpException).getResponse() as {
              code: string;
            }
          ).code,
        ).toBe('IMPORT_STALE');
        expect(quantity).toBe('3');
      }
      // The balance always equals the sum of the movement lines that built it.
      const [{ total }] = await t.db.$queryRawUnsafe<{ total: string }[]>(
        `SELECT COALESCE(SUM("quantity"), 0)::text AS "total"
           FROM "${t.tenant.schema}"."movement_lines"
          WHERE "product_id" = $1 AND "lot_id" = $2 AND "destination_location_id" = $3`,
        t.oil.id,
        stored.id,
        t.shelf.id,
      );
      expect(new Prisma.Decimal(total).toString()).toBe(quantity);
    }
  });
});
