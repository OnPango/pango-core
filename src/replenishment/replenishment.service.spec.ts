import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import type { SetReplenishmentDto } from './dto.js';
import { evaluateAlerts } from './evaluate-alerts.js';
import {
  ReplenishmentService,
  replenishmentProblem,
} from './replenishment.service.js';

vi.mock('./evaluate-alerts.js', () => ({
  evaluateAlerts: vi.fn(),
  stockLevels: vi.fn((_tx: unknown, pws: { id: number }[]) =>
    Promise.resolve(
      new Map(
        pws.map((pw) => [
          pw.id,
          {
            onHand: new Prisma.Decimal(12),
            reserved: new Prisma.Decimal(0),
            available: new Prisma.Decimal(12),
          },
        ]),
      ),
    ),
  ),
}));

const D = (value: number) => new Prisma.Decimal(value);
const north = { id: 1, name: 'North' };

function authWith(permissions: string[], warehouse = north): AuthContext {
  const role: RoleGrant = {
    id: 2,
    name: 'Clerk',
    isSystem: false,
    warehouse,
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
  isActive: true,
  stockUnit: { code: 'EA' },
};

const storedAlert = {
  id: 3,
  type: 'BELOW_ROP',
  severity: 1,
  status: 'OPEN',
  availableQuantity: D(8),
  reorderPoint: D(10),
  reorderPointSource: 'MANUAL',
  suggestedQuantity: D(42),
  message: 'TOR-001: available stock 8 EA is at or below the reorder point 10',
  createdAt: new Date('2026-11-07'),
  updatedAt: new Date('2026-11-07'),
  resolvedAt: null,
  productWarehouse: { product, warehouse: north },
};

function setup() {
  const tenant = {
    product: { findUnique: vi.fn().mockResolvedValue(product) },
    warehouse: {
      findUnique: vi.fn().mockResolvedValue({ ...north, isActive: true }),
    },
    productWarehouse: {
      upsert: vi.fn().mockResolvedValue({ id: 9 }),
      findUnique: vi.fn().mockResolvedValue({
        id: 9,
        productId: 5,
        warehouseId: 1,
        safetyStock: D(5),
        reorderPoint: D(10),
        minStock: null,
        maxStock: D(50),
        valueSource: 'MANUAL',
        alerts: [],
      }),
    },
    alert: {
      findUnique: vi.fn().mockResolvedValue(storedAlert),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 5 }]),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const service = new ReplenishmentService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

const parameters: SetReplenishmentDto = {
  safetyStock: 5,
  reorderPoint: 10,
  maxStock: 50,
};

describe('replenishmentProblem', () => {
  it('checks the order of the parameters', () => {
    expect(replenishmentProblem(parameters)).toBeNull();
    expect(replenishmentProblem({ safetyStock: 11, reorderPoint: 10 })).toMatch(
      /safety stock/,
    );
    // Without a reorder point, the safety stock stands alone.
    expect(
      replenishmentProblem({ safetyStock: 11, reorderPoint: 0 }),
    ).toBeNull();
    expect(
      replenishmentProblem({
        safetyStock: 0,
        reorderPoint: 0,
        minStock: 9,
        maxStock: 8,
      }),
    ).toMatch(/min stock/);
    expect(
      replenishmentProblem({ safetyStock: 0, reorderPoint: 60, maxStock: 50 }),
    ).toMatch(/reorder point/);
  });
});

describe('ReplenishmentService.set', () => {
  it('requires replenishment.manage in the warehouse', async () => {
    const { service } = setup();
    const elsewhere = authWith(['replenishment.manage'], {
      id: 2,
      name: 'South',
    });
    expect(await errorCode(service.set(elsewhere, 5, 1, parameters))).toBe(
      'FORBIDDEN',
    );
  });

  it('rejects inactive products and invalid parameters', async () => {
    const { tenant, service } = setup();
    const manager = authWith(['replenishment.manage']);
    expect(
      await errorCode(
        service.set(manager, 5, 1, { safetyStock: 20, reorderPoint: 10 }),
      ),
    ).toBe('REPLENISHMENT_INVALID');

    tenant.product.findUnique.mockResolvedValue({
      ...product,
      isActive: false,
    });
    expect(await errorCode(service.set(manager, 5, 1, parameters))).toBe(
      'PRODUCT_NOT_FOUND',
    );
    expect(tenant.$transaction).not.toHaveBeenCalled();
  });

  it('saves the values as manual under the product lock and re-evaluates the alert', async () => {
    const { tenant, service } = setup();
    const result = await service.set(
      authWith(['replenishment.manage']),
      5,
      1,
      parameters,
    );

    expect(tenant.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      5,
    );
    expect(tenant.productWarehouse.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          productId: 5,
          warehouseId: 1,
          reorderPoint: D(10),
          minStock: null,
          valueSource: 'MANUAL',
        }),
      }),
    );
    expect(evaluateAlerts).toHaveBeenCalledWith(tenant, [9]);
    expect(result).toMatchObject({
      available: 12,
      reorderPoint: 10,
      maxStock: 50,
      openAlert: null,
    });
  });
});

describe('ReplenishmentService alerts', () => {
  it('hides alerts of warehouses without alert.read', async () => {
    const { service } = setup();
    const south = authWith(['alert.read'], { id: 2, name: 'South' });
    expect(await errorCode(service.getAlert(south, 3))).toBe('ALERT_NOT_FOUND');

    const alert = await service.getAlert(authWith(['alert.read']), 3);
    expect(alert).toMatchObject({
      availableQuantity: 8,
      reorderPointSource: 'MANUAL',
      product: { sku: 'TOR-001', unit: 'EA' },
      warehouse: north,
    });
  });

  it('filters the list by readable warehouses', async () => {
    const { tenant, service } = setup();
    const reader = authWith(['alert.read']);
    expect(await service.listAlerts(reader, { warehouseId: 2 })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
    expect(tenant.alert.findMany).not.toHaveBeenCalled();

    await service.listAlerts(reader, { status: undefined, productId: 5 });
    expect(tenant.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productWarehouse: { warehouseId: { in: [1] }, productId: 5 } },
      }),
    );
  });
});
