import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { MovementsService } from '../movements/movements.service.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import {
  evaluateAlerts,
  stockLevels,
} from '../replenishment/evaluate-alerts.js';
import { type CreateStockRequestDto, StockRequestTypeValue } from './dto.js';
import {
  assertTransition,
  StockRequestsService,
  stockRequestNumber,
} from './stock-requests.service.js';

vi.mock('../replenishment/evaluate-alerts.js', () => ({
  evaluateAlerts: vi.fn(),
  stockLevels: vi.fn(),
}));

const D = (value: number) => new Prisma.Decimal(value);
const north = { id: 1, name: 'North' };

function authWith(permissions: string[], userId = 1): AuthContext {
  const role: RoleGrant = {
    id: 2,
    name: 'Clerk',
    isSystem: false,
    warehouse: north,
    permissions,
  };
  return {
    account: { id: userId, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: { id: userId, jobTitle: null, roles: [role] },
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

function storedRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    number: 'SR-00000001',
    type: 'INTERNAL_CONSUMPTION',
    status: 'PENDING',
    priority: 2,
    requiredDate: null,
    warehouse: north,
    department: { id: 4, name: 'Production' },
    requestedBy: { id: 1, accountId: 1 },
    notes: null,
    rejectionReason: null,
    movements: [],
    lines: [
      {
        lineNumber: 1,
        product: {
          id: 5,
          sku: 'TOR-001',
          name: 'Bolt',
          stockUnit: { code: 'EA' },
        },
        requestedQuantity: D(10),
        reservedQuantity: D(0),
      },
    ],
    events: [],
    createdAt: new Date('2026-11-07'),
    updatedAt: new Date('2026-11-07'),
    ...overrides,
  };
}

function setup(locked: Record<string, unknown> = {}) {
  const lockedRow = {
    id: 1,
    number: 'SR-00000001',
    status: 'PENDING',
    type: 'INTERNAL_CONSUMPTION',
    warehouseId: 1,
    departmentId: 4,
    requestedById: 1,
    ...locked,
  };
  const tenant = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        departmentId: 4,
        department: { id: 4, isActive: true },
      }),
    },
    warehouse: {
      findUnique: vi.fn().mockResolvedValue({ isActive: true }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: 1, defaultLocationId: 7 }),
    },
    product: { findMany: vi.fn().mockResolvedValue([{ id: 5 }]) },
    settings: {
      findUnique: vi.fn().mockResolvedValue({
        allowNegativeStock: false,
        stockRequestMovementType: { id: 3, nature: 'OUTBOUND' },
      }),
    },
    stockRequest: {
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(storedRequest()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(storedRequest()),
    },
    stockRequestLine: {
      findMany: vi.fn().mockResolvedValue([
        {
          lineNumber: 1,
          productId: 5,
          requestedQuantity: D(10),
          product: { sku: 'TOR-001' },
        },
      ]),
      updateMany: vi.fn(),
    },
    productWarehouse: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 9, productId: 5, warehouseId: 1 }]),
    },
    $queryRawUnsafe: vi.fn((sql: string) =>
      Promise.resolve(
        sql.includes('nextval')
          ? [{ id: 1 }]
          : sql.includes('stock_requests')
            ? [lockedRow]
            : [],
      ),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const control = {
    account: { findMany: vi.fn().mockResolvedValue([{ id: 1, name: 'Ana' }]) },
  };
  const movements = {
    planLines: vi.fn().mockResolvedValue([{ lineNumber: 1 }]),
    record: vi.fn().mockResolvedValue(12),
  };
  const service = new StockRequestsService(
    control as unknown as ControlPrismaService,
    { client: () => tenant } as unknown as TenantPrismaService,
    movements as unknown as MovementsService,
  );
  return { tenant, movements, service };
}

const request: CreateStockRequestDto = {
  warehouseId: 1,
  lines: [{ productId: 5, quantity: 10 }],
};

const level = (available: number) =>
  new Map([
    [9, { onHand: D(available), reserved: D(0), available: D(available) }],
  ]);

describe('stock request cycle', () => {
  it('allows only the defined transitions', () => {
    expect(() => assertTransition('PENDING', 'IN_PROGRESS')).not.toThrow();
    expect(() => assertTransition('IN_PROGRESS', 'FULFILLED')).not.toThrow();
    expect(() => assertTransition('IN_PROGRESS', 'CANCELLED')).toThrow();
    expect(() => assertTransition('REJECTED', 'FULFILLED')).toThrow();
    expect(() => assertTransition('FULFILLED', 'FULFILLED')).toThrow();
  });

  it('pads the request number', () => {
    expect(stockRequestNumber(7)).toBe('SR-00000007');
  });
});

describe('StockRequestsService.create', () => {
  it('needs stock_request.create in the warehouse and a department', async () => {
    const { tenant, service } = setup();
    expect(await errorCode(service.create(authWith([]), request))).toBe(
      'FORBIDDEN',
    );

    const creator = authWith(['stock_request.create']);
    tenant.user.findUnique.mockResolvedValue({ department: null });
    expect(await errorCode(service.create(creator, request))).toBe(
      'DEPARTMENT_REQUIRED',
    );
  });

  it('rejects other request types, inactive and repeated products', async () => {
    const { tenant, service } = setup();
    const creator = authWith(['stock_request.create']);
    expect(
      await errorCode(
        service.create(creator, {
          warehouseId: 1,
          type: StockRequestTypeValue.RETURN,
          lines: [{ productId: 5, quantity: 1 }],
        }),
      ),
    ).toBe('STOCK_REQUEST_TYPE_NOT_SUPPORTED');
    expect(
      await errorCode(
        service.create(creator, {
          warehouseId: 1,
          lines: [
            { productId: 5, quantity: 1 },
            { productId: 5, quantity: 2 },
          ],
        }),
      ),
    ).toBe('PRODUCT_DUPLICATED');
    tenant.product.findMany.mockResolvedValue([]);
    expect(await errorCode(service.create(creator, request))).toBe(
      'PRODUCT_INVALID',
    );
    expect(tenant.$transaction).not.toHaveBeenCalled();
  });

  it("creates it PENDING for the user's department, with its first event", async () => {
    const { tenant, service } = setup();
    const result = await service.create(
      authWith(['stock_request.create']),
      request,
    );
    expect(tenant.stockRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 1,
        number: 'SR-00000001',
        type: 'INTERNAL_CONSUMPTION',
        departmentId: 4,
        requestedById: 1,
        events: { create: { status: 'PENDING', changedById: 1 } },
      }),
    });
    expect(result.requestedBy).toEqual({ id: 1, name: 'Ana' });
  });
});

describe('StockRequestsService attention', () => {
  const clerk = authWith(['stock_request.read', 'stock_request.approve']);

  it('reserves the requested stock when attention starts', async () => {
    const { tenant, service } = setup();
    vi.mocked(stockLevels).mockResolvedValue(level(12));
    await service.start(clerk, 1);
    expect(tenant.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"reserved_quantity" = "requested_quantity"'),
      1,
    );
    expect(tenant.stockRequest.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: 'IN_PROGRESS',
        events: {
          create: { status: 'IN_PROGRESS', changedById: 1, reason: null },
        },
      },
    });
    expect(evaluateAlerts).toHaveBeenCalledWith(tenant, [9]);
  });

  it('does not start without enough available stock', async () => {
    const { tenant, service } = setup();
    vi.mocked(stockLevels).mockResolvedValue(level(9));
    expect(await errorCode(service.start(clerk, 1))).toBe('INSUFFICIENT_STOCK');
    expect(tenant.stockRequest.update).not.toHaveBeenCalled();
  });

  it('needs stock_request.approve in the warehouse', async () => {
    const { service } = setup();
    expect(
      await errorCode(service.start(authWith(['stock_request.read']), 1)),
    ).toBe('FORBIDDEN');
  });

  it('fulfils with an outbound movement linked to the request, only once', async () => {
    const { tenant, movements, service } = setup({ status: 'IN_PROGRESS' });
    await service.fulfil(clerk, 1, {
      lines: [{ lineNumber: 1, locationId: 7 }],
    });
    expect(movements.planLines).toHaveBeenCalledWith(tenant, 1, 'OUTBOUND', [
      { productId: 5, quantity: 10, locationId: 7, lotCode: undefined },
    ]);
    expect(movements.record).toHaveBeenCalledWith(
      tenant,
      'tenant_demo',
      expect.objectContaining({
        movementTypeId: 3,
        stockRequestId: 1,
        departmentId: 4,
        documentRef: 'SR-00000001',
      }),
    );
    expect(tenant.stockRequestLine.updateMany).toHaveBeenCalledWith({
      where: { stockRequestId: 1 },
      data: { reservedQuantity: 0 },
    });

    const again = setup({ status: 'FULFILLED' });
    expect(await errorCode(again.service.fulfil(clerk, 1, {}))).toBe(
      'STOCK_REQUEST_STATUS_INVALID',
    );
    expect(again.movements.record).not.toHaveBeenCalled();
  });

  it('rejects unknown fulfil lines', async () => {
    const { service } = setup({ status: 'IN_PROGRESS' });
    expect(
      await errorCode(service.fulfil(clerk, 1, { lines: [{ lineNumber: 2 }] })),
    ).toBe('LINE_INVALID');
  });

  it('records the rejection reason and releases the reservation', async () => {
    const { tenant, service } = setup({ status: 'IN_PROGRESS' });
    await service.reject(clerk, 1, { reason: 'Reserved for production' });
    expect(tenant.stockRequestLine.updateMany).toHaveBeenCalled();
    expect(tenant.stockRequest.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Reserved for production',
        events: {
          create: {
            status: 'REJECTED',
            changedById: 1,
            reason: 'Reserved for production',
          },
        },
      },
    });
    expect(evaluateAlerts).toHaveBeenCalled();
  });

  it('lets only the requester cancel', async () => {
    const { service } = setup({ requestedById: 2 });
    expect(await errorCode(service.cancel(clerk, 1))).toBe('NOT_REQUESTER');
    const own = setup();
    expect((await own.service.cancel(clerk, 1)).number).toBe('SR-00000001');
  });
});

describe('StockRequestsService reads', () => {
  it("shows the readable warehouses' requests and the user's department's", async () => {
    const { tenant, service } = setup();
    await service.list(authWith(['stock_request.read']), { productId: 5 });
    expect(tenant.stockRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { OR: [{ warehouseId: { in: [1] } }, { departmentId: 4 }] },
            { lines: { some: { productId: 5 } } },
          ],
        },
      }),
    );
  });

  it('answers 404 for a request the user cannot see', async () => {
    const { tenant, service } = setup();
    tenant.stockRequest.findFirst.mockResolvedValue(null);
    expect(await errorCode(service.get(authWith([]), 1))).toBe(
      'STOCK_REQUEST_NOT_FOUND',
    );
  });
});
