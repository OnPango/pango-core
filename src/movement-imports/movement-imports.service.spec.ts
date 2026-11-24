import { readFileSync } from 'node:fs';
import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { V1_COLUMNS } from './import-format.js';
import {
  checkBatch,
  MovementImportsService,
} from './movement-imports.service.js';

const TEMPLATE = readFileSync(
  new URL(
    '../../docs/templates/pango-standard-kardex-movement-history-import-v1.csv',
    import.meta.url,
  ),
  'utf8',
);

/** The template's rows as the frontend sends them. */
const templateRows = () => {
  const [header, ...lines] = TEMPLATE.trim().split('\n');
  const columns = header.trim().split(',');
  return lines.map((line, i) => {
    const cells = line.trim().split(',');
    return {
      rowNumber: i + 2,
      values: Object.fromEntries(
        V1_COLUMNS.map((c) => [c, cells[columns.indexOf(c)] || null]),
      ),
    };
  });
};

const grant = (
  warehouse: number | null,
  permissions = ['movement.import', 'movement.read'],
): RoleGrant => ({
  id: 1,
  name: warehouse === null ? 'Owner' : 'Admin',
  isSystem: warehouse === null,
  warehouse: warehouse === null ? null : { id: warehouse, name: 'W' },
  permissions,
});

const authWith = (roles: RoleGrant[], userId = 7) =>
  ({
    account: { id: 1, email: 'a@b.c', name: 'A' },
    organization: {
      id: 1,
      subdomain: 'demo',
      legalName: 'Demo',
      schemaName: 'tenant_demo',
    },
    user: { id: userId, jobTitle: null, roles },
  }) as AuthContext;

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const e = error as HttpException;
    return { status: e.getStatus(), ...(e.getResponse() as object) };
  }
  throw new Error('expected a failure');
};

function setup(record: Record<string, unknown> = {}) {
  const current = {
    id: 3,
    sourceNamespace: 'siigo-main',
    fileName: 'kardex.xlsx',
    status: 'RECEIVING',
    revision: 0,
    rowCount: 0,
    validRowCount: 0,
    invalidRowCount: 0,
    duplicateRowCount: 0,
    issueCounts: {},
    uploadedById: 7,
    confirmedAt: null,
    savedCount: null,
    skippedCount: null,
    createdAt: new Date('2026-11-24T10:00:00Z'),
    ...record,
  };
  const stored = templateRows().map((r) => ({
    rowNumber: r.rowNumber,
    source: r.values,
  }));
  // Only the import tables are writable: any other write would throw.
  const tx = {
    $queryRawUnsafe: vi.fn((sql: string) => {
      if (sql.includes('"warehouses"')) {
        return Promise.resolve([{ id: 1, code: 'MAIN' }]);
      }
      if (sql.includes('"products"')) {
        return Promise.resolve([
          { id: 10, sku: 'SKU-001', tracksLots: false, unitCode: 'EA' },
        ]);
      }
      if (sql.includes('"locations"')) {
        return Promise.resolve([{ id: 100, warehouseId: 1, code: 'DEFAULT' }]);
      }
      if (sql.includes('"taken"')) return Promise.resolve([{ taken: 0 }]);
      return Promise.resolve([]);
    }),
    $executeRawUnsafe: vi.fn().mockResolvedValue(4),
    settings: {
      findUnique: vi.fn().mockResolvedValue({ timeZone: 'America/Bogota' }),
    },
    movementType: {
      findMany: vi.fn().mockResolvedValue([
        { id: 1, name: 'Opening balance', countsAsDemand: false },
        { id: 2, name: 'Purchase receipt', countsAsDemand: false },
        { id: 3, name: 'Consumption issue', countsAsDemand: true },
        { id: 6, name: 'Sales issue', countsAsDemand: true },
      ]),
    },
    roleAssignment: {
      findMany: vi.fn().mockResolvedValue([
        {
          warehouseId: null,
          role: {
            movementTypes: [1, 2, 3, 6].map((movementTypeId) => ({
              movementTypeId,
            })),
          },
        },
      ]),
    },
    historicalMovement: { findMany: vi.fn().mockResolvedValue([]) },
    movementImport: {
      findUnique: vi.fn().mockResolvedValue(current),
      update: vi.fn(({ data }: { data: object }) =>
        Promise.resolve({ ...current, ...data }),
      ),
    },
    movementImportRow: {
      findMany: vi.fn().mockResolvedValue(stored),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    movementImportIssue: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const tenant = {
    ...tx,
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    movementImport: {
      ...tx.movementImport,
      create: vi.fn(({ data }: { data: object }) =>
        Promise.resolve({ ...current, ...data }),
      ),
    },
    movementImportIssue: {
      ...tx.movementImportIssue,
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const tenants = { client: () => tenant } as unknown as TenantPrismaService;
  return { tx, tenant, service: new MovementImportsService(tenants) };
}

describe('checkBatch', () => {
  it('accepts template rows and fills missing columns with null', () => {
    const { rows, problems } = checkBatch([
      { rowNumber: 2, values: { sku: 'SKU-001' } },
    ]);
    expect(problems).toEqual([]);
    expect(rows[0].values.sku).toBe('SKU-001');
    expect(rows[0].values.business_date).toBeNull();
  });

  it('rejects rows outside the template format, without touching prototypes', () => {
    const { problems } = checkBatch([
      JSON.parse('{"rowNumber": 2, "values": {"__proto__": {"polluted": 1}}}'),
      { rowNumber: 1, values: {} },
      { rowNumber: 3, values: { sku: 5 } },
      { rowNumber: 4, values: { sku: 'x'.repeat(1001) } },
      { rowNumber: 5, values: [] },
      { rowNumber: 6, values: {} },
      { rowNumber: 6, values: {} },
      'row',
    ]);
    expect(problems).toEqual([
      'rows[0]: unknown column "__proto__"',
      'rows[1]: rowNumber must be an integer from 2 (row 1 is the header)',
      'rows[2]: sku must be a string or null',
      'rows[3]: sku is longer than 1000 characters',
      'rows[4]: values must be an object',
      'rows[6]: rowNumber 6 is repeated',
      'rows[7]: must be an object',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects values whose prototype was set from a __proto__ key', () => {
    const values = Object.create({ polluted: 1 }) as object;
    expect(checkBatch([{ rowNumber: 2, values }]).problems).toEqual([
      'rows[0]: values must be an object',
    ]);
  });
});

describe('MovementImportsService', () => {
  it('starts an import with a lower-case namespace', async () => {
    const { service, tenant } = setup();
    const created = await service.create(authWith([grant(null)]), {
      sourceNamespace: 'Siigo-Main',
      fileName: ' kardex.xlsx ',
    });
    expect(tenant.movementImport.create).toHaveBeenCalledWith({
      data: {
        sourceNamespace: 'siigo-main',
        fileName: 'kardex.xlsx',
        uploadedById: 7,
      },
    });
    expect(created.status).toBe('RECEIVING');
  });

  it('appends a batch, replacing resent row numbers', async () => {
    const { service, tx } = setup({ rowCount: 4, status: 'VALIDATED' });
    tx.movementImportRow.deleteMany.mockResolvedValueOnce({ count: 2 });
    const result = await service.appendRows(authWith([grant(null)]), 3, {
      rows: templateRows().slice(0, 2),
    });
    expect(tx.movementImportRow.deleteMany).toHaveBeenCalledWith({
      where: { importId: 3, rowNumber: { in: [2, 3] } },
    });
    expect(tx.movementImport.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { status: 'RECEIVING', rowCount: 4 },
    });
    expect(result).toMatchObject({ received: 2, import: { rowCount: 4 } });
  });

  it('refuses batches of other users, confirmed imports and over the row limit', async () => {
    const rows = templateRows();
    expect(
      await failure(
        setup().service.appendRows(authWith([grant(null)], 8), 3, { rows }),
      ),
    ).toMatchObject({ status: 403, code: 'IMPORT_NOT_YOURS' });
    expect(
      await failure(
        setup({ status: 'CONFIRMED' }).service.appendRows(
          authWith([grant(null)]),
          3,
          { rows },
        ),
      ),
    ).toMatchObject({ status: 409, code: 'IMPORT_CONFIRMED' });
    expect(
      await failure(
        setup({ rowCount: 199_999 }).service.appendRows(
          authWith([grant(null)]),
          3,
          { rows },
        ),
      ),
    ).toMatchObject({ status: 413, code: 'TOO_MANY_ROWS' });
    expect(
      await failure(
        setup().service.appendRows(authWith([grant(null)]), 3, {
          rows: [{ rowNumber: 2, values: { color: 'red' } }],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'ROWS_INVALID' });
  });

  it('validates the template: 4 valid rows staged, closing 105, new revision', async () => {
    const { service, tx } = setup({ rowCount: 4 });
    await service.validate(authWith([grant(null)]), 3);
    const staged = tx.movementImportRow.createMany.mock.calls[0][0].data;
    expect(staged.map((r: { status: string }) => r.status)).toEqual([
      'VALID',
      'VALID',
      'VALID',
      'VALID',
    ]);
    expect(staged[3]).toMatchObject({
      rowNumber: 5,
      leg: 'LINE',
      movementCode: 'INTERNAL_CONSUMPTION',
      warehouseId: 1,
      productId: 10,
      locationCode: 'DEFAULT',
    });
    expect(staged[3].runningBalance.toString()).toBe('105');
    expect(staged[3].source).toMatchObject({ sku: 'SKU-001' });
    expect(tx.movementImport.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({
        status: 'VALIDATED',
        revision: { increment: 1 },
        validRowCount: 4,
        invalidRowCount: 0,
      }),
    });
    expect(tx.historicalMovement.findMany).toHaveBeenCalledWith({
      where: {
        sourceNamespace: 'siigo-main',
        externalMovementId: {
          in: ['OPEN-001', 'PUR-001', 'SALE-001', 'USE-001'],
        },
      },
    });
  });

  it('refuses to validate an empty import', async () => {
    expect(
      await failure(setup().service.validate(authWith([grant(null)]), 3)),
    ).toMatchObject({ status: 409, code: 'IMPORT_EMPTY' });
  });

  it('confirms the validated revision into the history, one confirmation at a time', async () => {
    const { service, tx } = setup({
      status: 'VALIDATED',
      revision: 2,
      rowCount: 4,
      validRowCount: 4,
      duplicateRowCount: 1,
    });
    const result = await service.confirm(authWith([grant(null)]), 3, {
      revision: 2,
    });
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain(
      'pg_advisory_xact_lock',
    );
    const [insert, importId, namespace] = tx.$executeRawUnsafe.mock.calls[1];
    expect(insert).toContain(
      'INSERT INTO "tenant_demo"."historical_movements"',
    );
    expect(insert).toContain(`"status" = 'VALID'`);
    expect([importId, namespace]).toEqual([3, 'siigo-main']);
    expect(result).toMatchObject({
      status: 'CONFIRMED',
      savedCount: 4,
      skippedCount: 1,
    });
  });

  it('answers a repeated confirmation with the first result', async () => {
    const { service, tx } = setup({ status: 'CONFIRMED', savedCount: 4 });
    const result = await service.confirm(authWith([grant(null)]), 3, {
      revision: 1,
    });
    expect(result).toMatchObject({ status: 'CONFIRMED', savedCount: 4 });
    // Only the advisory lock ran: nothing was inserted.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale confirmation', async () => {
    const validated = { status: 'VALIDATED', revision: 2, validRowCount: 4 };
    const auth = authWith([grant(null)]);
    expect(
      await failure(setup().service.confirm(auth, 3, { revision: 1 })),
    ).toMatchObject({
      code: 'IMPORT_NOT_VALIDATED',
    });
    expect(
      await failure(setup(validated).service.confirm(auth, 3, { revision: 1 })),
    ).toMatchObject({ status: 409, code: 'IMPORT_STALE' });

    // Another import saved some of the lines meanwhile.
    const taken = setup(validated);
    taken.tx.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('"taken"') ? [{ taken: 1 }] : []),
    );
    expect(
      await failure(taken.service.confirm(auth, 3, { revision: 2 })),
    ).toMatchObject({
      code: 'IMPORT_STALE',
    });
    expect(taken.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);

    // The user lost the import permission in a warehouse of the rows.
    const lost = setup(validated);
    lost.tx.movementImportRow.count.mockResolvedValueOnce(1);
    expect(
      await failure(
        lost.service.confirm(authWith([grant(2)]), 3, { revision: 2 }),
      ),
    ).toMatchObject({ code: 'IMPORT_STALE' });
  });

  it('shows an import to its uploader and to who may import in all its warehouses', async () => {
    const { service, tx } = setup();
    await expect(
      service.report(authWith([grant(2)]), 3, {}),
    ).resolves.toMatchObject({
      import: { id: 3 },
    });
    tx.movementImportRow.findMany.mockResolvedValueOnce([{ warehouseId: 1 }]);
    await expect(
      service.report(authWith([grant(1)], 8), 3, {}),
    ).resolves.toBeDefined();
    tx.movementImportRow.findMany.mockResolvedValueOnce([{ warehouseId: 1 }]);
    expect(
      await failure(service.report(authWith([grant(2)], 8), 3, {})),
    ).toMatchObject({
      status: 404,
      code: 'IMPORT_NOT_FOUND',
    });
    tx.movementImportRow.findMany.mockResolvedValueOnce([]);
    expect(
      await failure(service.report(authWith([grant(1)], 8), 3, {})),
    ).toMatchObject({
      status: 404,
    });
  });

  it('lists the history only of the warehouses where movements can be read', async () => {
    const { service, tenant } = setup();
    const reader = authWith([grant(2, ['movement.read'])]);
    await expect(
      service.history(reader, { warehouseId: 1 }),
    ).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    expect(tenant.$queryRawUnsafe).not.toHaveBeenCalled();
    tenant.$queryRawUnsafe
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);
    await service.history(reader, {});
    const [countSql, warehouses] = tenant.$queryRawUnsafe.mock.calls[0];
    expect(countSql).toContain('"historical_movements"');
    expect(warehouses).toEqual([2]);
    expect(tenant.$queryRawUnsafe.mock.calls[1][0]).toContain('"afterCutover"');
  });
});
