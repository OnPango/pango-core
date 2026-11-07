import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { evaluateAlerts } from '../replenishment/evaluate-alerts.js';
import { AdjustmentDirection, type CreateMovementDto } from './dto.js';
import {
  lineEffect,
  movementNumber,
  MovementsService,
  weightedAverage,
} from './movements.service.js';

vi.mock('../replenishment/evaluate-alerts.js', () => ({
  evaluateAlerts: vi.fn(),
}));

const D = (value: number) => new Prisma.Decimal(value);

function role(
  permissions: string[],
  warehouse: { id: number; name: string } | null,
): RoleGrant {
  return { id: 2, name: 'Clerk', isSystem: false, warehouse, permissions };
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

const north = { id: 1, name: 'North' };
const clerk = authWith([role(['movement.create', 'movement.read'], north)]);

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function storedMovement(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    number: 'MV-00000001',
    status: 'CONFIRMED',
    stockRequestId: null,
    movementType: {
      id: 2,
      name: 'Purchase receipt',
      nature: 'INBOUND',
      countsAsDemand: false,
    },
    department: null,
    registeredBy: { id: 1, accountId: 1 },
    documentRef: null,
    notes: null,
    occurredAt: new Date('2026-11-06'),
    lines: [
      {
        lineNumber: 1,
        product: {
          id: 5,
          sku: 'TOR-001',
          name: 'Bolt',
          stockUnit: { code: 'EA' },
        },
        originLocation: null,
        destinationLocation: { id: 7, code: 'DEFAULT', warehouse: north },
        lot: null,
        quantity: D(10),
        unitCost: D(100),
      },
    ],
    ...overrides,
  };
}

function setup(nature = 'INBOUND') {
  const tenant = {
    warehouse: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 1, isActive: true, defaultLocationId: 7 }),
    },
    movementType: {
      findUnique: vi.fn().mockResolvedValue({ id: 2, nature }),
      findFirst: vi.fn().mockResolvedValue({ id: 2 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    settings: {
      findUnique: vi.fn().mockResolvedValue({ allowNegativeStock: false }),
    },
    department: { findUnique: vi.fn() },
    product: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 5, sku: 'TOR-001', tracksLots: false }]),
      update: vi.fn(),
    },
    location: { findMany: vi.fn().mockResolvedValue([]) },
    productWarehouse: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 9, defaultLocationId: null }),
    },
    lot: { upsert: vi.fn(), findUnique: vi.fn() },
    movement: {
      create: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(storedMovement()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(storedMovement()),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRawUnsafe: vi.fn((sql: string) =>
      Promise.resolve(
        sql.includes('nextval') ? [{ id: 1 }] : [{ id: 5, averageCost: '100' }],
      ),
    ),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const control = {
    account: {
      findMany: vi.fn().mockResolvedValue([{ id: 1, name: 'Ana' }]),
    },
  };
  const service = new MovementsService(
    control as unknown as ControlPrismaService,
    { client: () => tenant } as unknown as TenantPrismaService,
  );
  return { tenant, service };
}

const issueOf = (quantity: number): CreateMovementDto => ({
  movementTypeId: 3,
  warehouseId: 1,
  lines: [{ productId: 5, quantity }],
});

const receipt: CreateMovementDto = {
  movementTypeId: 2,
  warehouseId: 1,
  lines: [{ productId: 5, quantity: 10, unitCost: 200 }],
};

describe('movement helpers', () => {
  it('derives the line effect from the nature or the adjustment direction', () => {
    expect(lineEffect('INBOUND', undefined, 1)).toBe('IN');
    expect(lineEffect('OUTBOUND', undefined, 1)).toBe('OUT');
    expect(lineEffect('ADJUSTMENT', AdjustmentDirection.DECREASE, 1)).toBe(
      'OUT',
    );
    expect(() => lineEffect('ADJUSTMENT', undefined, 1)).toThrow();
    expect(() =>
      lineEffect('INBOUND', AdjustmentDirection.INCREASE, 1),
    ).toThrow();
  });

  it('computes the weighted average cost', () => {
    expect(weightedAverage(D(10), D(100), D(10), D(200)).toNumber()).toBe(150);
    expect(weightedAverage(D(0), D(100), D(5), D(80)).toNumber()).toBe(80);
    // Negative on-hand carries no cost.
    expect(weightedAverage(D(-3), D(100), D(5), D(80)).toNumber()).toBe(80);
  });

  it('pads the movement number', () => {
    expect(movementNumber(42)).toBe('MV-00000042');
  });
});

describe('MovementsService.create', () => {
  it('requires movement.create in the warehouse', async () => {
    const { service } = setup();
    const elsewhere = authWith([
      role(['movement.create'], { id: 2, name: 'South' }),
    ]);
    expect(await errorCode(service.create(elsewhere, receipt))).toBe(
      'FORBIDDEN',
    );
  });

  it('rejects transfers and types the roles do not allow', async () => {
    const transfer = setup('TRANSFER');
    expect(await errorCode(transfer.service.create(clerk, receipt))).toBe(
      'MOVEMENT_TYPE_NOT_SUPPORTED',
    );

    const { tenant, service } = setup();
    tenant.movementType.findFirst.mockResolvedValue(null);
    expect(await errorCode(service.create(clerk, receipt))).toBe(
      'MOVEMENT_TYPE_NOT_ALLOWED',
    );
  });

  it('validates products and lots before opening the transaction', async () => {
    const { tenant, service } = setup();
    tenant.product.findMany.mockResolvedValue([]);
    expect(await errorCode(service.create(clerk, receipt))).toBe(
      'PRODUCT_INVALID',
    );

    tenant.product.findMany.mockResolvedValue([
      { id: 5, sku: 'TOR-001', tracksLots: true },
    ]);
    expect(await errorCode(service.create(clerk, receipt))).toBe(
      'LOT_REQUIRED',
    );
    expect(tenant.$transaction).not.toHaveBeenCalled();
  });

  it('enables the product in the warehouse, adds stock and updates the average cost', async () => {
    const { tenant, service } = setup();
    tenant.productWarehouse.findMany.mockResolvedValue([
      // Stock in another warehouse counts for the average cost.
      {
        id: 3,
        productId: 5,
        warehouseId: 2,
        defaultLocationId: null,
        stockBalances: [{ quantity: D(10) }],
      },
    ]);

    const result = await service.create(clerk, receipt);

    expect(tenant.productWarehouse.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { productId: 5, warehouseId: 1 } }),
    );
    expect(tenant.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT'),
      9,
      7,
      null,
      '10',
    );
    expect(tenant.product.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { averageCost: D(150) },
    });
    const data = tenant.movement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: 1,
      number: 'MV-00000001',
      status: 'CONFIRMED',
      registeredById: 1,
    });
    expect(data.lines.create[0]).toMatchObject({
      originLocationId: null,
      destinationLocationId: 7,
    });
    // CU-12a runs in the same transaction, on the movement's warehouse only.
    expect(evaluateAlerts).toHaveBeenCalledWith(tenant, [9]);
    expect(result.warehouse).toEqual(north);
    expect(result.registeredBy).toEqual({ id: 1, name: 'Ana' });
  });

  it('rejects an outbound line without enough stock', async () => {
    const { tenant, service } = setup('OUTBOUND');
    tenant.productWarehouse.findMany.mockResolvedValue([
      {
        id: 9,
        productId: 5,
        warehouseId: 1,
        defaultLocationId: null,
        stockBalances: [{ quantity: D(3) }],
      },
    ]);
    tenant.$executeRawUnsafe.mockResolvedValue(0);

    const issue = issueOf(4);
    expect(await errorCode(service.create(clerk, issue))).toBe(
      'INSUFFICIENT_STOCK',
    );
    expect(tenant.movement.create).not.toHaveBeenCalled();
  });

  it('rejects an outbound line of a product not enabled in the warehouse', async () => {
    const { tenant, service } = setup('OUTBOUND');
    const issue = issueOf(1);
    expect(await errorCode(service.create(clerk, issue))).toBe(
      'INSUFFICIENT_STOCK',
    );
    expect(tenant.productWarehouse.create).not.toHaveBeenCalled();
  });
});

describe('MovementsService reads', () => {
  it('hides movements of warehouses without movement.read', async () => {
    const { service } = setup();
    const south = authWith([role(['movement.read'], { id: 2, name: 'South' })]);
    expect(await errorCode(service.get(south, 1))).toBe('MOVEMENT_NOT_FOUND');
    expect((await service.get(clerk, 1)).number).toBe('MV-00000001');
  });

  it('returns an empty page for a warehouse the user cannot read', async () => {
    const { tenant, service } = setup();
    const page = await service.list(clerk, { warehouseId: 2 });
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    expect(tenant.movement.findMany).not.toHaveBeenCalled();
  });
});
