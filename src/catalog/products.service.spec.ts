import type { HttpException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { CatalogStatusFilter } from './dto.js';
import { evaluateAlerts } from '../replenishment/evaluate-alerts.js';
import { categorySubtree, ProductsService } from './products.service.js';

vi.mock('../replenishment/evaluate-alerts.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../replenishment/evaluate-alerts.js')
  >()),
  evaluateAlerts: vi.fn(),
}));

const auth = {
  organization: { schemaName: 'tenant_demo' },
} as unknown as AuthContext;

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    sku: 'TOR-001',
    name: 'Bolt',
    description: null,
    categoryId: 3,
    stockUnitId: 1,
    lengthCm: new Prisma.Decimal('5.5'),
    widthCm: null,
    heightCm: null,
    weightKg: null,
    volumeL: null,
    tracksLots: false,
    isActive: true,
    averageCost: new Prisma.Decimal(0),
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    category: { id: 3, name: 'Hardware' },
    stockUnit: { id: 1, code: 'EA', name: 'Each' },
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function setup() {
  const tenant = {
    product: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(product()),
      update: vi.fn().mockResolvedValue(product()),
    },
    category: {
      findUnique: vi.fn().mockResolvedValue({ id: 3, isActive: true }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    unitOfMeasure: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
    movementLine: { findFirst: vi.fn().mockResolvedValue(null) },
    lot: { count: vi.fn().mockResolvedValue(0) },
    productWarehouse: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  vi.mocked(evaluateAlerts).mockClear();
  const service = new ProductsService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

const createDto = {
  sku: 'TOR-001',
  name: 'Bolt',
  categoryId: 3,
  stockUnitId: 1,
};

describe('categorySubtree', () => {
  it('returns the category and every descendant', () => {
    const categories = [
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
      { id: 4, parentId: null },
    ];
    expect(categorySubtree(categories, 1).sort((a, b) => a - b)).toEqual([
      1, 2, 3,
    ]);
    expect(categorySubtree(categories, 4)).toEqual([4]);
  });
});

describe('ProductsService.list', () => {
  it('defaults to active products and paginates', async () => {
    const { tenant, service } = setup();
    tenant.product.count.mockResolvedValue(30);
    tenant.product.findMany.mockResolvedValue([product()]);

    const page = await service.list(auth, { page: 2, pageSize: 10 });

    expect(tenant.product.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { isActive: true },
      skip: 10,
      take: 10,
    });
    expect(page).toMatchObject({ total: 30, page: 2, pageSize: 10 });
    expect(page.items[0]?.lengthCm).toBe(5.5);
  });

  it('searches code or name and includes subcategories', async () => {
    const { tenant, service } = setup();
    tenant.category.findMany.mockResolvedValue([
      { id: 3, parentId: null },
      { id: 5, parentId: 3 },
    ]);

    await service.list(auth, {
      search: 'bolt',
      categoryId: 3,
      status: CatalogStatusFilter.ALL,
    });

    const where = tenant.product.findMany.mock.calls[0]?.[0].where;
    expect(where.isActive).toBeUndefined();
    expect(where.OR).toHaveLength(2);
    expect([...where.categoryId.in].sort((a, b) => a - b)).toEqual([3, 5]);
  });
});

describe('ProductsService.get', () => {
  it('sums the stock per warehouse and in total', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue({
      ...product(),
      warehouses: [
        {
          warehouse: { id: 1, name: 'Main' },
          stockBalances: [
            { quantity: new Prisma.Decimal('10.5') },
            { quantity: new Prisma.Decimal('4.5') },
          ],
          safetyStock: new Prisma.Decimal(2),
          reorderPoint: new Prisma.Decimal(5),
          valueSource: 'MANUAL',
        },
        {
          warehouse: { id: 2, name: 'Store' },
          stockBalances: [],
          safetyStock: new Prisma.Decimal(0),
          reorderPoint: new Prisma.Decimal(0),
          valueSource: 'MANUAL',
        },
      ],
    });

    const detail = await service.get(auth, 1);

    expect(detail.totalOnHand).toBe(15);
    expect(detail.warehouses.map((w) => w.onHand)).toEqual([15, 0]);
    expect(detail.hasMovements).toBe(false);
    // The cached weighted average cost, as a number.
    expect(detail.averageCost).toBe(0);
  });

  it('returns 404 for an unknown product', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(null);
    expect(await errorCode(service.get(auth, 9))).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('ProductsService.create', () => {
  it('rejects an inactive category and an unknown unit', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique.mockResolvedValueOnce({ isActive: false });
    expect(await errorCode(service.create(auth, createDto))).toBe(
      'CATEGORY_INVALID',
    );
    tenant.unitOfMeasure.findUnique.mockResolvedValueOnce(null);
    expect(await errorCode(service.create(auth, createDto))).toBe(
      'STOCK_UNIT_INVALID',
    );
  });

  it('rejects a code already used, ignoring case', async () => {
    const { tenant, service } = setup();
    tenant.product.findFirst.mockResolvedValue({ id: 2 });
    expect(
      await errorCode(service.create(auth, { ...createDto, sku: 'tor-001' })),
    ).toBe('SKU_TAKEN');
    expect(tenant.product.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      sku: { equals: 'tor-001', mode: 'insensitive' },
    });
  });

  it('maps a concurrent unique violation to SKU_TAKEN', async () => {
    const { tenant, service } = setup();
    tenant.product.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect(await errorCode(service.create(auth, createDto))).toBe('SKU_TAKEN');
  });

  it('creates the product without stock', async () => {
    const { tenant, service } = setup();
    await service.create(auth, { ...createDto, description: '', weightKg: 1 });
    expect(tenant.product.create.mock.calls[0]?.[0].data).toMatchObject({
      sku: 'TOR-001',
      description: null,
      weightKg: 1,
      lengthCm: null,
      tracksLots: false,
    });
  });
});

describe('ProductsService.update', () => {
  it('locks the code once the product has movements', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    tenant.movementLine.findFirst.mockResolvedValue({ movementId: 1 });
    expect(await errorCode(service.update(auth, 1, { sku: 'NEW' }))).toBe(
      'SKU_LOCKED',
    );
  });

  it('allows resending the same code on a product with movements', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    tenant.movementLine.findFirst.mockResolvedValue({ movementId: 1 });
    await service.update(auth, 1, { sku: 'TOR-001', name: 'Hex bolt' });
    expect(tenant.product.update.mock.calls[0]?.[0].data).toEqual({
      name: 'Hex bolt',
    });
  });

  it('locks lot tracking once the product has lots', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    tenant.lot.count.mockResolvedValue(1);
    expect(await errorCode(service.update(auth, 1, { tracksLots: true }))).toBe(
      'TRACKS_LOTS_LOCKED',
    );
  });

  it('archiving locks the product and evaluates its alerts in every warehouse', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    tenant.productWarehouse.findMany.mockResolvedValue([
      { id: 9, productId: 1 },
      { id: 12, productId: 1 },
    ]);
    await service.update(auth, 1, { isActive: false });
    expect(tenant.productWarehouse.findMany.mock.calls[0]?.[0].where).toEqual({
      productId: 1,
    });
    expect(tenant.$queryRawUnsafe.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(tenant.$queryRawUnsafe.mock.calls[0]?.[1]).toEqual([1]);
    expect(evaluateAlerts).toHaveBeenCalledWith(tenant, [9, 12]);
    // The product is written before its alerts are evaluated.
    expect(tenant.product.update.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(evaluateAlerts).mock.invocationCallOrder[0]!,
    );
  });

  it('does not touch alerts when the status does not change', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    await service.update(auth, 1, { name: 'Hex bolt', isActive: true });
    expect(tenant.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(evaluateAlerts).toHaveBeenCalledWith(tenant, []);
  });

  it('deactivates and clears measures', async () => {
    const { tenant, service } = setup();
    tenant.product.findUnique.mockResolvedValue(product());
    await service.update(auth, 1, { isActive: false, lengthCm: null });
    expect(tenant.product.update.mock.calls[0]?.[0].data).toEqual({
      isActive: false,
      lengthCm: null,
    });
  });
});
