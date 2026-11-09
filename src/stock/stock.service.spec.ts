import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { stockLevels } from '../replenishment/evaluate-alerts.js';
import { byExpiry, likePattern, StockService } from './stock.service.js';

vi.mock('../replenishment/evaluate-alerts.js', () => ({
  stockLevels: vi.fn(),
}));

const D = (value: number) => new Prisma.Decimal(value);
const north = { id: 1, name: 'North' };

function authWith(permissions: string[]): AuthContext {
  const role: RoleGrant = {
    id: 2,
    name: 'Clerk',
    isSystem: false,
    warehouse: north,
    permissions,
  };
  return {
    account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: { id: 1, jobTitle: null, roles: [role] },
  };
}
const reader = authWith(['stock.read']);

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

const product = {
  id: 5,
  sku: 'TOR-001',
  name: 'Bolt',
  tracksLots: true,
  isActive: true,
  category: { id: 2, name: 'Hardware' },
  stockUnit: { id: 1, code: 'EA', name: 'Each' },
};

const lot = (id: number, code: string, expiry: string | null) => ({
  id,
  code,
  manufactureDate: null,
  expiryDate: expiry ? new Date(expiry) : null,
});

function setup() {
  const tenant = {
    warehouse: { findUnique: vi.fn().mockResolvedValue(north) },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    product: {
      findUnique: vi.fn().mockResolvedValue(product),
      findMany: vi.fn().mockResolvedValue([product]),
    },
    productWarehouse: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 9, productId: 5, warehouseId: 1 }),
    },
    stockBalance: { findMany: vi.fn().mockResolvedValue([]) },
    lot: { findFirst: vi.fn(), update: vi.fn() },
    $queryRawUnsafe: vi.fn((sql: string) =>
      Promise.resolve(
        sql.includes('COUNT(*)') ? [{ total: 1 }] : [{ id: 9, productId: 5 }],
      ),
    ),
  };
  const service = new StockService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  vi.mocked(stockLevels).mockResolvedValue(
    new Map([[9, { onHand: D(50), reserved: D(10), available: D(40) }]]),
  );
  return { tenant, service };
}

describe('stock helpers', () => {
  it('orders lots by earliest expiry, without one last', () => {
    const lots = [
      lot(1, 'B', null),
      lot(2, 'C', '2027-01-01'),
      lot(3, 'A', '2026-12-01'),
      lot(4, 'A', null),
    ];
    expect(lots.sort(byExpiry).map((l) => l.id)).toEqual([3, 2, 4, 1]);
  });

  it('escapes LIKE wildcards in the search', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });
});

describe('StockService', () => {
  it('hides warehouses without stock.read as not found', async () => {
    const { tenant, service } = setup();
    expect(
      await errorCode(
        service.list(authWith(['movement.read']), { warehouseId: 1 }),
      ),
    ).toBe('WAREHOUSE_NOT_FOUND');
    expect(await errorCode(service.lots(reader, 5, 2))).toBe(
      'WAREHOUSE_NOT_FOUND',
    );
    expect(tenant.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('lists the stock of a warehouse with the filters as parameters', async () => {
    const { tenant, service } = setup();
    const page = await service.list(reader, {
      warehouseId: 1,
      search: 'bolt',
      includeZero: true,
    });
    expect(tenant.$queryRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('ORDER BY "name", "pid" LIMIT $5 OFFSET $6'),
      1,
      '%bolt%',
      null,
      true,
      25,
      0,
    );
    expect(page).toEqual({
      items: [{ product, onHand: 50, reserved: 10, available: 40 }],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  });

  it('answers an empty page without matches', async () => {
    const { tenant, service } = setup();
    tenant.$queryRawUnsafe.mockResolvedValue([{ total: 0 }]);
    expect(await service.list(reader, { warehouseId: 1 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
  });

  it('groups the lots of a product with their locations', async () => {
    const { tenant, service } = setup();
    const later = lot(4, 'L-2', '2027-04-30');
    const sooner = lot(3, 'L-1', '2026-12-31');
    tenant.stockBalance.findMany.mockResolvedValue([
      { quantity: D(20), location: { id: 7, code: 'A-1' }, lot: later },
      { quantity: D(5), location: { id: 8, code: 'B-1' }, lot: later },
      { quantity: D(3), location: { id: 7, code: 'A-1' }, lot: sooner },
    ]);
    expect(await service.lots(reader, 5, 1)).toEqual([
      {
        id: 3,
        code: 'L-1',
        manufactureDate: null,
        expiryDate: '2026-12-31',
        onHand: 3,
        locations: [{ location: { id: 7, code: 'A-1' }, onHand: 3 }],
      },
      {
        id: 4,
        code: 'L-2',
        manufactureDate: null,
        expiryDate: '2027-04-30',
        onHand: 25,
        locations: [
          { location: { id: 7, code: 'A-1' }, onHand: 20 },
          { location: { id: 8, code: 'B-1' }, onHand: 5 },
        ],
      },
    ]);
  });

  it('answers zeros for a product not enabled in the warehouse', async () => {
    const { tenant, service } = setup();
    tenant.productWarehouse.findUnique.mockResolvedValue(null);
    expect(await service.productStock(reader, 5, 1)).toMatchObject({
      warehouse: north,
      onHand: 0,
      available: 0,
      balances: [],
    });
  });

  it('keeps the expiry date after the manufacture date', async () => {
    const { tenant, service } = setup();
    const stored = { ...lot(4, 'L-2', '2027-04-30') };
    tenant.lot.findFirst.mockResolvedValue(stored);
    expect(
      await errorCode(
        service.updateLot(reader, 5, 4, { manufactureDate: '2027-05-01' }),
      ),
    ).toBe('LOT_DATES_INVALID');

    tenant.lot.update.mockResolvedValue({
      ...stored,
      manufactureDate: new Date('2026-10-01'),
    });
    const updated = await service.updateLot(reader, 5, 4, {
      manufactureDate: '2026-10-01',
    });
    expect(tenant.lot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          manufactureDate: new Date('2026-10-01'),
          expiryDate: new Date('2027-04-30'),
        },
      }),
    );
    expect(updated.manufactureDate).toBe('2026-10-01');

    tenant.lot.findFirst.mockResolvedValue(null);
    expect(await errorCode(service.updateLot(reader, 5, 9, {}))).toBe(
      'LOT_NOT_FOUND',
    );
  });
});
