import type { HttpException } from '@nestjs/common';
import {
  type AuthContext,
  type RoleGrant,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { WarehousesService } from './warehouses.service.js';

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

const manager = authWith([role(['warehouse.manage', 'warehouse.read'], null)]);

function warehouse(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: 'BOD-1',
    name: 'Bodega Norte',
    type: 'WAREHOUSE',
    address: null,
    defaultLocationId: 7,
    isActive: true,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    defaultLocation: { id: 7, code: 'DEFAULT' },
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
    warehouse: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(warehouse()),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue(warehouse()),
    },
    location: { create: vi.fn().mockResolvedValue({ id: 7 }) },
    stockBalance: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const service = new WarehousesService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

const createDto = {
  code: 'BOD-1',
  name: 'Bodega Norte',
  type: 'WAREHOUSE' as const,
};

describe('warehousesWithPermission', () => {
  it('returns ALL for an assignment with no warehouse', () => {
    expect(
      warehousesWithPermission(
        [role(['warehouse.read'], null), role([], { id: 2, name: 'B' })],
        'warehouse.read',
      ),
    ).toBe('ALL');
  });

  it('returns the warehouses whose assignments grant it', () => {
    expect(
      warehousesWithPermission(
        [
          role(['warehouse.read'], { id: 2, name: 'B' }),
          role(['warehouse.read'], { id: 2, name: 'B' }),
          role(['stock.read'], { id: 3, name: 'C' }),
        ],
        'warehouse.read',
      ),
    ).toEqual([2]);
  });
});

describe('WarehousesService.list', () => {
  it('shows only the warehouses the user can read', async () => {
    const { tenant, service } = setup();
    await service.list(
      authWith([role(['warehouse.read'], { id: 4, name: 'Store' })]),
      {},
    );
    expect(tenant.warehouse.findMany.mock.calls[0]?.[0].where).toEqual({
      id: { in: [4] },
      isActive: true,
    });
  });

  it('shows every warehouse to managers and filters by type and search', async () => {
    const { tenant, service } = setup();
    await service.list(manager, { type: 'STORE', search: 'norte' });
    const where = tenant.warehouse.findMany.mock.calls[0]?.[0].where;
    expect(where.id).toBeUndefined();
    expect(where).toMatchObject({ type: 'STORE', isActive: true });
    expect(where.OR).toHaveLength(2);
  });
});

describe('WarehousesService.get', () => {
  it('hides a warehouse the user cannot read', async () => {
    const { tenant, service } = setup();
    expect(
      await errorCode(
        service.get(
          authWith([role(['warehouse.read'], { id: 4, name: 'Store' })]),
          1,
        ),
      ),
    ).toBe('WAREHOUSE_NOT_FOUND');
    expect(tenant.warehouse.findUnique).not.toHaveBeenCalled();
  });
});

describe('WarehousesService.create', () => {
  it('creates the warehouse with its default location', async () => {
    const { tenant, service } = setup();
    const result = await service.create(manager, createDto);

    expect(tenant.location.create).toHaveBeenCalledWith({
      data: { warehouseId: 1, code: 'DEFAULT' },
    });
    expect(tenant.warehouse.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 1 },
      data: { defaultLocationId: 7 },
    });
    expect(result.defaultLocation).toEqual({ id: 7, code: 'DEFAULT' });
  });

  it('rejects a name already used, ignoring case', async () => {
    const { tenant, service } = setup();
    tenant.warehouse.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2 });
    expect(
      await errorCode(
        service.create(manager, { ...createDto, name: 'bodega norte' }),
      ),
    ).toBe('WAREHOUSE_NAME_TAKEN');
    expect(tenant.warehouse.findFirst.mock.calls[1]?.[0].where).toMatchObject({
      name: { equals: 'bodega norte', mode: 'insensitive' },
    });
    expect(tenant.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a code already used', async () => {
    const { tenant, service } = setup();
    tenant.warehouse.findFirst.mockResolvedValueOnce({ id: 2 });
    expect(await errorCode(service.create(manager, createDto))).toBe(
      'WAREHOUSE_CODE_TAKEN',
    );
  });
});

describe('WarehousesService.update', () => {
  it('does not deactivate a warehouse with stock on hand', async () => {
    const { tenant, service } = setup();
    tenant.stockBalance.findFirst.mockResolvedValue({ id: 3 });
    expect(
      await errorCode(service.update(manager, 1, { isActive: false })),
    ).toBe('WAREHOUSE_HAS_STOCK');
  });

  it('skips the uniqueness checks for unchanged values', async () => {
    const { tenant, service } = setup();
    await service.update(manager, 1, {
      name: 'Bodega Norte',
      type: 'STORE',
      address: '',
    });
    expect(tenant.warehouse.findFirst).not.toHaveBeenCalled();
    expect(tenant.warehouse.update.mock.calls[0]?.[0].data).toEqual({
      type: 'STORE',
      address: null,
    });
  });

  it('returns 404 for an unknown warehouse', async () => {
    const { tenant, service } = setup();
    tenant.warehouse.findUnique.mockResolvedValue(null);
    expect(await errorCode(service.update(manager, 9, {}))).toBe(
      'WAREHOUSE_NOT_FOUND',
    );
  });
});
