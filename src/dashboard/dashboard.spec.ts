import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import {
  DashboardAlertsService,
  lastMonths,
} from './dashboard-alerts.service.js';
import { daysOfCover, type StockPosition } from './dashboard-data.js';
import {
  DashboardInventoryService,
  familyRoots,
} from './dashboard-inventory.service.js';
import { readableWarehouses } from './dashboard-scope.js';
import { levelBuckets, levelPoints } from './dashboard-level.service.js';
import {
  DashboardSummaryService,
  oneMonthBefore,
  valueBefore,
} from './dashboard-summary.service.js';

const north = { id: 1, name: 'Norte' };

function role(
  permissions: string[],
  warehouse: { id: number; name: string } | null,
  isSystem = false,
): RoleGrant {
  return { id: 2, name: 'Clerk', isSystem, warehouse, permissions };
}

function authWith(roles: RoleGrant[]): AuthContext {
  return {
    account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: { id: 1, jobTitle: null, roles },
  };
}

function position(overrides: Partial<StockPosition> = {}): StockPosition {
  return {
    productWarehouseId: 9,
    productId: 5,
    sku: 'TOR-001',
    name: 'Tornillo',
    unit: 'EA',
    categoryId: 4,
    averageCost: 100,
    warehouseId: 1,
    warehouseName: 'Norte',
    isActive: true,
    onHand: 10,
    reserved: 0,
    available: 10,
    maxStock: null,
    ...overrides,
  };
}

/** A tenant whose raw queries answer, in order, the given result sets. */
function tenantWith(results: unknown[][], extra: Record<string, unknown> = {}) {
  const queue = [...results];
  return {
    settings: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ timeZone: 'America/Bogota', currency: 'COP' }),
    },
    $queryRawUnsafe: vi.fn((..._args: unknown[]) =>
      Promise.resolve(queue.shift() ?? []),
    ),
    ...extra,
  };
}

const tenants = (tenant: unknown) =>
  ({ client: () => tenant }) as unknown as TenantPrismaService;

describe('readableWarehouses', () => {
  it('reads every warehouse, some, or none', () => {
    const owner = authWith([role(['stock.read'], null, true)]);
    const clerk = authWith([role(['stock.read'], north)]);
    expect(readableWarehouses(owner, 'stock.read')).toBeNull();
    expect(readableWarehouses(clerk, 'stock.read')).toEqual([1]);
    expect(readableWarehouses(clerk, 'alert.read')).toBe(false);
  });

  it('narrows to the asked warehouse, empty when not readable', () => {
    const clerk = authWith([role(['stock.read'], north)]);
    expect(readableWarehouses(clerk, 'stock.read', 1)).toEqual([1]);
    expect(readableWarehouses(clerk, 'stock.read', 2)).toEqual([]);
  });
});

describe('dashboard helpers', () => {
  it('finds the top-level family of nested categories', () => {
    const roots = familyRoots([
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
      { id: 4, parentId: null },
    ]);
    expect([...roots.entries()]).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 4],
    ]);
  });

  it('lists the last months, crossing years', () => {
    expect(lastMonths('2026-02-15', 4)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('counts days of cover only with a positive forecast', () => {
    expect(daysOfCover(10, 3)).toBe(3);
    expect(daysOfCover(-4, 3)).toBe(0);
    expect(daysOfCover(10, 0)).toBeNull();
    expect(daysOfCover(10, undefined)).toBeNull();
  });
});

describe('DashboardSummaryService', () => {
  it('leaves null every block the user cannot read', async () => {
    const tenant = tenantWith([]);
    const service = new DashboardSummaryService(
      tenants(tenant),
      {} as ControlPrismaService,
    );
    const result = await service.summary(
      authWith([role(['warehouse.read'], north)]),
      {},
    );
    expect(result.kpis).toEqual({
      products: null,
      stockValue: null,
      lowStock: null,
      pendingRequests: null,
    });
    expect(result.lowStockItems).toBeNull();
    expect(result.recentActivity).toBeNull();
    expect(tenant.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('values the stock now and a month ago, ignoring negative balances', async () => {
    const rows = [
      position({ onHand: 10, averageCost: 100 }),
      position({ productId: 6, onHand: -3, averageCost: 50 }),
    ];
    // Since a month ago: 4 entered product 5, 2 left product 6.
    const net = [
      { productId: 5, warehouseId: 1, day: '2026-11-10', net: 4 },
      { productId: 6, warehouseId: 1, day: '2026-11-12', net: -2 },
    ];
    const tenant = tenantWith([rows, net]);
    const service = new DashboardSummaryService(
      tenants(tenant),
      {} as ControlPrismaService,
    );
    const result = await service.summary(
      authWith([role(['stock.read'], north)]),
      {},
    );
    expect(result.kpis.stockValue).toEqual({ current: 1000, previous: 600 });
    expect(tenant.$queryRawUnsafe.mock.calls[0][1]).toEqual([1]);
  });
});

describe('summary helpers', () => {
  it('compares with the same moment one month earlier', () => {
    expect(oneMonthBefore(new Date('2026-11-23T10:00:00')).getMonth()).toBe(9);
  });

  it('rebuilds the value of a month ago at today’s cost', () => {
    expect(
      valueBefore(
        [position({ onHand: 3, averageCost: 10 })],
        [{ productId: 5, warehouseId: 1, day: '2026-11-20', net: -2 }],
      ),
    ).toBe(50);
  });
});

describe('inventory level', () => {
  it('makes daily periods up to 30 days and weekly ones beyond', () => {
    expect(levelBuckets('2026-11-23', 7)).toHaveLength(7);
    expect(levelBuckets('2026-11-23', 7).at(-1)).toEqual({
      start: '2026-11-23',
      end: '2026-11-23',
    });
    const weeks = levelBuckets('2026-11-25', 90);
    expect(weeks).toHaveLength(13);
    // The current week starts on Monday and ends today.
    expect(weeks.at(-1)).toEqual({ start: '2026-11-23', end: '2026-11-25' });
  });

  it('counts each product once, at the end of each period', () => {
    const onHand = new Map([
      ['5:1', 10],
      ['5:2', 4],
      ['6:1', 0],
    ]);
    const points = levelPoints(
      [
        { start: '2026-11-21', end: '2026-11-21' },
        { start: '2026-11-22', end: '2026-11-22' },
      ],
      onHand,
      // Product 6 sold its last 3 units on the 22nd.
      [{ productId: 6, warehouseId: 1, day: '2026-11-22', net: -3 }],
      // Product 5 went low in warehouse 2 only.
      [{ key: '5:2', createdDay: '2026-11-22', resolvedDay: null }],
    );
    expect(points).toEqual([
      // Product 5 (in two warehouses) counts once.
      { start: '2026-11-21', end: '2026-11-21', inStock: 2, lowStock: 0 },
      // Low in one warehouse is low; product 6 ran out.
      { start: '2026-11-22', end: '2026-11-22', inStock: 0, lowStock: 1 },
    ]);
  });
});

describe('DashboardInventoryService', () => {
  const owner = authWith([role(['stock.read'], null, true)]);

  function setup(positions: StockPosition[], movementDates: unknown[]) {
    // Order of raw queries: positions, movement dates, expiring lots, forecasts.
    const tenant = tenantWith(
      [positions, movementDates, [], [{ productWarehouseId: 12, daily: 2 }]],
      {
        category: {
          findMany: vi.fn().mockResolvedValue([
            { id: 1, parentId: null, name: 'Ferretería' },
            { id: 4, parentId: 1, name: 'Tornillería' },
          ]),
        },
      },
    );
    return new DashboardInventoryService(tenants(tenant));
  }

  it('groups the value by top-level family', async () => {
    const service = setup([position({ onHand: 3, averageCost: 10 })], []);
    const { value } = await service.inventory(owner, {});
    expect(value).toEqual({
      total: 30,
      byFamily: [{ familyId: 1, name: 'Ferretería', value: 30, items: 1 }],
    });
  });

  it('flags excess over the max stock or 12 weeks of forecast', async () => {
    const service = setup(
      [
        position({ onHand: 50, available: 50, maxStock: 20, averageCost: 10 }),
        position({
          productWarehouseId: 12,
          onHand: 200,
          available: 200,
          averageCost: 1,
        }),
        position({ productWarehouseId: 13, onHand: 999, available: 999 }),
      ],
      [],
    );
    const { excess } = await service.inventory(owner, {});
    expect(excess.items).toEqual([
      expect.objectContaining({
        limit: 20,
        limitSource: 'MAX_STOCK',
        excess: 30,
        value: 300,
      }),
      // 2 a day × 84 days = 168.
      expect.objectContaining({
        limit: 168,
        limitSource: 'FORECAST',
        excess: 32,
        value: 32,
      }),
    ]);
    // No max stock and no forecast: nothing to compare with.
    expect(excess.total).toBe(2);
  });

  it('calls idle only old stock that has not left lately', async () => {
    const old = new Date('2020-01-01');
    const recent = new Date();
    const service = setup(
      [
        position({ productId: 1 }),
        position({ productId: 2, productWarehouseId: 20 }),
        position({ productId: 3, productWarehouseId: 21 }),
      ],
      [
        { productId: 1, warehouseId: 1, firstAt: old, lastOutAt: null },
        { productId: 2, warehouseId: 1, firstAt: old, lastOutAt: recent },
        { productId: 3, warehouseId: 1, firstAt: recent, lastOutAt: null },
      ],
    );
    const { idle } = await service.inventory(owner, {});
    expect(idle.total).toBe(1);
    expect(idle.items[0].product.id).toBe(1);
  });
});

describe('DashboardAlertsService', () => {
  it('fills every month and places each count', async () => {
    const tenant = tenantWith([
      [
        {
          warehouseId: 1,
          warehouseName: 'Norte',
          critical: 1,
          high: 0,
          medium: 2,
        },
      ],
      [
        { month: '2026-11', kind: 'created', total: 4 },
        { month: '2026-11', kind: 'resolved', total: 3 },
        { month: '2026-10', kind: 'attended', total: 1 },
      ],
    ]);
    vi.useFakeTimers({ now: new Date('2026-11-20T15:00:00Z') });
    try {
      const service = new DashboardAlertsService(tenants(tenant));
      const result = await service.alerts(
        authWith([role(['alert.read'], null, true)]),
        { months: 3 },
      );
      expect(result.bySeverity).toEqual([
        { warehouse: north, critical: 1, high: 0, medium: 2 },
      ]);
      expect(result.monthly).toEqual([
        { month: '2026-09', created: 0, attended: 0, resolved: 0 },
        { month: '2026-10', created: 0, attended: 1, resolved: 0 },
        { month: '2026-11', created: 4, attended: 0, resolved: 3 },
      ]);
      // The trend starts on the first day of the oldest month.
      expect(tenant.$queryRawUnsafe.mock.calls[1][2]).toBe('2026-09-01');
    } finally {
      vi.useRealTimers();
    }
  });
});
