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
};

const row = (values: Record<string, string>) => ({
  sku: 'NEW-1',
  name: 'Taladro',
  category: 'Herramientas',
  stockUnit: 'ud',
  warehouse: 'NORTE',
  tracksLots: 'Cantidad',
  stockQuantity: '10',
  unitCost: '100',
  ...values,
});

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as { code: string };
  }
  throw new Error('Expected the promise to reject');
}

describe('previewing an inventory import', () => {
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
  let southAdmin: AuthContext;
  let id: number;

  beforeAll(async () => {
    tenant = await provisionTenant('preview');
    db = tenantClient(tenant.schema);
    const north = await createWarehouse(db, 'NORTE');
    const south = await createWarehouse(db, 'SUR');
    owner = await sessionFor(db, tenant, tenant.userId);
    northAdmin = await sessionFor(
      db,
      tenant,
      (await createUser(db, 904, 'Admin', [north.id])).id,
    );
    southAdmin = await sessionFor(
      db,
      tenant,
      (await createUser(db, 905, 'Admin', [south.id])).id,
    );

    const { import: record } = await imports.create(owner, {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'inventario.xlsx',
      sheetName: 'Inventario',
      totalRows: 4,
      mapping,
    });
    id = record.id;
    await imports.appendRows(owner, id, {
      batchNumber: 1,
      rows: [
        { rowNumber: 2, values: row({}) },
        { rowNumber: 3, values: row({ sku: 'NEW-2', unitCost: '' }) },
        { rowNumber: 4, values: row({ sku: 'NEW-3', stockUnit: 'cm' }) },
        { rowNumber: 5, values: row({}) },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
    await control.$disconnect();
  });

  it('shows the rows as PENDING before validation', async () => {
    const rows = await imports.rowPage(owner, id, {});
    expect(rows.revision).toBe(0);
    expect(rows.total).toBe(4);
    expect(rows.items[0]).toEqual({
      rowNumber: 2,
      status: 'PENDING',
      sku: 'NEW-1',
      product: null,
      category: null,
      warehouse: null,
      locationCode: null,
      lot: null,
      stockUnit: null,
      quantity: null,
      unitCost: null,
      issues: 0,
    });
    expect(await imports.issuePage(owner, id, {})).toMatchObject({
      revision: 0,
      total: 0,
      items: [],
    });
  });

  it('pages the validated rows and filters them by status', async () => {
    await imports.validate(owner, id);

    const all = await imports.rowPage(owner, id, { pageSize: 2, page: 2 });
    expect(all).toMatchObject({ revision: 1, total: 4, page: 2, pageSize: 2 });
    expect(all.items.map((r) => [r.rowNumber, r.status])).toEqual([
      [4, 'INVALID'],
      [5, 'DUPLICATE'],
    ]);

    const valid = await imports.rowPage(owner, id, { status: 'VALID' });
    expect(valid.total).toBe(2);
    expect(valid.items[0]).toMatchObject({
      rowNumber: 2,
      status: 'VALID',
      sku: 'NEW-1',
      product: { id: null, name: 'Taladro', isNew: true },
      category: { id: null, name: 'Herramientas', isNew: true },
      warehouse: { code: 'NORTE', isNew: false },
      locationCode: 'DEFAULT',
      lot: null,
      stockUnit: 'EA',
      quantity: '10',
      unitCost: '100',
      issues: 0,
    });
  });

  it('filters issues by severity and code, with their source column', async () => {
    const errors = await imports.issuePage(owner, id, { severity: 'ERROR' });
    expect(errors.items).toEqual([
      expect.objectContaining({
        rowNumber: 4,
        field: 'stockUnit',
        sourceColumn: { column: 4, header: 'Unidad de medida *' },
        code: 'STOCK_UNIT_INVALID',
        value: 'cm',
      }),
    ]);
    const missingCost = await imports.issuePage(owner, id, {
      code: 'COST_MISSING',
    });
    expect(missingCost).toMatchObject({ revision: 1, total: 1 });
    expect(missingCost.items[0]).toMatchObject({
      rowNumber: 3,
      sourceColumn: { column: 8, header: 'Costo unitario' },
    });
    expect(
      (await imports.issuePage(owner, id, { severity: 'WARNING' })).items.map(
        (i) => i.code,
      ),
    ).toEqual(['COST_MISSING', 'DUPLICATE_ROW']);
  });

  it('follows the revision of the last validation', async () => {
    await imports.validate(owner, id);
    expect((await imports.rowPage(owner, id, {})).revision).toBe(2);
    expect((await imports.issuePage(owner, id, {})).revision).toBe(2);
  });

  it('shows the preview to whoever may see the import, and to nobody else', async () => {
    // The rows touch Norte only: its admin sees them, Sur's admin does not.
    await expect(imports.rowPage(northAdmin, id, {})).resolves.toMatchObject({
      total: 4,
    });
    expect((await errorOf(imports.rowPage(southAdmin, id, {}))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
    expect((await errorOf(imports.issuePage(southAdmin, id, {}))).code).toBe(
      'IMPORT_NOT_FOUND',
    );
  });

  it('is empty once the import closes', async () => {
    await imports.cancel(owner, id);
    expect(await imports.rowPage(owner, id, {})).toMatchObject({
      total: 0,
      items: [],
    });
    expect(await imports.issuePage(owner, id, {})).toMatchObject({
      total: 0,
      items: [],
    });
  });
});
