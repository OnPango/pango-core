import { randomUUID } from 'node:crypto';
import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../../src/auth/auth-context.js';
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
  warehouseCode: { column: 14, header: 'Código de bodega' },
};

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as { code: string };
  }
  throw new Error('Expected the promise to reject');
}

describe('validating an inventory import against the database', () => {
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
  );
  const movements = new MovementsService({} as never, {} as never);
  let tenant: TestTenant;
  let db: PrismaClient;
  let owner: AuthContext;
  let northAdmin: AuthContext;
  let north: Awaited<ReturnType<typeof createWarehouse>>;
  let shelf: number;
  let bolt: { id: number; sku: string };
  let oil: { id: number; sku: string };

  /** Records an inbound movement, as `POST /movements` does. */
  async function receive(
    product: { id: number; sku: string },
    quantity: number,
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
            unitCost: new Prisma.Decimal(10),
            locationId,
            lotCode,
          },
        ],
        allowNegative: false,
      }),
    );
  }

  /** An open import of these rows (row 2 onwards), all sent, started by `auth`. */
  async function stage(auth: AuthContext, rows: Record<string, string>[]) {
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
    return record.id;
  }

  const row = (values: Record<string, string>) => ({
    sku: 'TOR-001',
    name: 'Tornillo',
    category: 'Tornillería',
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
      category: 'Lubricantes',
      stockUnit: 'litro',
      tracksLots: 'Lote',
      ...values,
    });

  beforeAll(async () => {
    tenant = await provisionTenant('validation');
    db = tenantClient(tenant.schema);
    north = await db.warehouse.update({
      where: { id: (await createWarehouse(db, 'NORTE')).id },
      data: { name: 'Norte' },
    });
    await db.warehouse.update({
      where: { id: (await createWarehouse(db, 'SUR')).id },
      data: { name: 'Sur' },
    });
    shelf = (
      await db.location.create({
        data: { warehouseId: north.id, code: 'A-01' },
      })
    ).id;
    const [ea, ltr] = await Promise.all([
      db.unitOfMeasure.findUniqueOrThrow({ where: { code: 'EA' } }),
      db.unitOfMeasure.findUniqueOrThrow({ where: { code: 'LTR' } }),
    ]);
    const hardware = await db.category.create({
      data: { name: 'Tornillería' },
    });
    const lubricants = await db.category.create({
      data: { name: 'Lubricantes' },
    });
    bolt = await db.product.create({
      data: {
        sku: 'TOR-001',
        name: 'Tornillo',
        categoryId: hardware.id,
        stockUnitId: ea.id,
      },
    });
    oil = await db.product.create({
      data: {
        sku: 'ACE-001',
        name: 'Aceite',
        categoryId: lubricants.id,
        stockUnitId: ltr.id,
        tracksLots: true,
      },
    });
    // Stock already in Pango: the bolt at Norte's DEFAULT, oil lot L-1 on A-01.
    await receive(bolt, 50);
    await receive(oil, 20, shelf, 'L-1');
    owner = await sessionFor(db, tenant, tenant.userId);
    northAdmin = await sessionFor(
      db,
      tenant,
      (await createUser(db, 903, 'Admin', [north.id])).id,
    );
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
    await control.$disconnect();
  });

  it('needs every declared row before validating', async () => {
    await db.inventoryImport.updateMany({
      where: { status: { in: ['RECEIVING', 'READY', 'INVALID'] } },
      data: { status: 'CANCELLED' },
    });
    const { import: record } = await imports.create(owner, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'f.xlsx',
      sheetName: 'Inventario',
      totalRows: 2,
      mapping,
    });
    await imports.appendRows(owner, record.id, {
      batchNumber: 1,
      rows: [{ rowNumber: 2, values: row({}) }],
    });
    expect(await errorOf(imports.validate(owner, record.id))).toMatchObject({
      code: 'IMPORT_INCOMPLETE',
      receivedRows: 1,
      totalRows: 2,
    });
  });

  it('applies every rule against the real data and stores the outcome', async () => {
    const id = await stage(owner, [
      row({}), // 2: the bolt already has stock at Norte DEFAULT
      row({ locationCode: 'a-01' }), // 3: another location: a new identity
      oilRow({ lotCode: 'L-1', locationCode: 'A-01' }), // 4: lot L-1 already there
      oilRow({ lotCode: 'L-2' }), // 5: a new lot
      row({
        sku: 'NEW-1',
        name: 'Taladro',
        category: 'tornillería',
        warehouse: 'Oeste',
        warehouseCode: 'OES',
      }), // 6
      row({ sku: 'NEW-2', name: 'Broca', category: 'Tornilleria' }), // 7: accents matter
      row({ sku: 'tor-001', warehouse: 'sur', stockQuantity: 'diez' }), // 8: bad number
    ]);

    const report = await imports.validate(owner, id);

    expect(report.import).toMatchObject({ status: 'INVALID', revision: 1 });
    const issues = await imports.issuePage(owner, id, { pageSize: 100 });
    expect(issues.items.map((i) => [i.rowNumber, i.code])).toEqual([
      [2, 'ALREADY_HAS_STOCK'],
      [4, 'ALREADY_HAS_STOCK'],
      [8, 'INVALID_VALUE'],
    ]);
    expect(issues.items[2]).toMatchObject({
      field: 'stockQuantity',
      sourceColumn: { column: 7, header: 'Saldo inicial *' },
      value: 'diez',
    });
    expect(report.issues.total).toBe(3);
    expect(report.import.summary).toMatchObject({
      totalRows: 7,
      validRows: 4,
      invalidRows: 3,
      errors: 3,
      create: { categories: 1, products: 2, warehouses: 1, lots: 1 },
    });
    expect(report.import.summary).not.toHaveProperty('warehouseIds');

    const stored = await db.inventoryImportRow.findMany({
      where: { importId: id },
      orderBy: { rowNumber: 'asc' },
    });
    expect(stored.map((r) => r.status)).toEqual([
      'INVALID',
      'VALID',
      'INVALID',
      'VALID',
      'VALID',
      'VALID',
      'INVALID',
    ]);
    expect(stored[1].preview).toMatchObject({
      product: { id: bolt.id, isNew: false },
      warehouse: { id: north.id, isNew: false },
      locationCode: 'A-01',
    });
    expect(stored[4].preview).toMatchObject({
      category: { isNew: false, name: 'Tornillería' },
      warehouse: { code: 'OES', isNew: true },
    });
    expect(stored[5].preview).toMatchObject({
      category: { isNew: true, name: 'Tornilleria' },
    });
    // Validation writes nothing definitive.
    expect(await db.product.count()).toBe(2);
    expect(await db.warehouse.count()).toBe(2);
    expect(await db.lot.count()).toBe(1);
  });

  it('is READY without errors, and a new revision sees changes in Pango', async () => {
    const id = await stage(owner, [
      row({ locationCode: 'A-01' }),
      oilRow({ lotCode: 'L-3' }),
    ]);
    const first = await imports.validate(owner, id);
    const fingerprint = async () =>
      (await db.inventoryImport.findUniqueOrThrow({ where: { id } }))
        .validationFingerprint;
    const before = await fingerprint();

    const again = await imports.validate(owner, id);
    expect(first.import).toMatchObject({ status: 'READY', revision: 1 });
    expect(again.import).toMatchObject({ status: 'READY', revision: 2 });
    expect(await fingerprint()).toBe(before);

    // Someone receives the bolt on A-01: the identity is no longer eligible.
    await receive(bolt, 5, shelf);
    const third = await imports.validate(owner, id);
    expect(third.import).toMatchObject({ status: 'INVALID', revision: 3 });
    expect(third.issues.items.map((i) => [i.rowNumber, i.code])).toEqual([
      [2, 'ALREADY_HAS_STOCK'],
    ]);
    expect(await fingerprint()).not.toBe(before);
  });

  it("checks the user's warehouses and records the ones touched", async () => {
    const id = await stage(northAdmin, [
      oilRow({ lotCode: 'L-4' }),
      row({ warehouse: 'Sur', stockQuantity: '3' }),
    ]);
    const report = await imports.validate(northAdmin, id);
    expect(report.issues.items.map((i) => [i.rowNumber, i.code])).toEqual([
      [3, 'WAREHOUSE_FORBIDDEN'],
    ]);
    const record = await db.inventoryImport.findUniqueOrThrow({
      where: { id },
    });
    expect(record.summary).toMatchObject({ warehouseIds: [north.id] });

    // An Owner's import touching only Norte becomes visible to Norte's admin.
    const ownerImport = await stage(owner, [oilRow({ lotCode: 'L-5' })]);
    expect((await errorOf(imports.get(northAdmin, ownerImport))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
    await imports.validate(owner, ownerImport);
    await expect(imports.get(northAdmin, ownerImport)).resolves.toMatchObject({
      id: ownerImport,
    });
    expect(
      (await errorOf(imports.validate(northAdmin, ownerImport))).code,
    ).toBe('IMPORT_NOT_YOURS');
  });

  it('refuses to validate a closed import', async () => {
    const id = await stage(owner, [row({ locationCode: 'A-01' })]);
    await imports.cancel(owner, id);
    expect((await errorOf(imports.validate(owner, id))).code).toBe(
      'IMPORT_CLOSED',
    );
  });
});
