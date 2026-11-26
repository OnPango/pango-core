import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { SearchService } from './search.service.js';

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

const owner = authWith([role(['catalog.read', 'alert.read'], null, true)]);
const north = { id: 3, name: 'Norte' };

function setup() {
  const tenant = {
    product: {
      count: vi.fn().mockResolvedValue(7),
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 1,
            sku: 'TOR-001',
            name: 'Tornillo',
            category: { name: 'Tor' },
          },
        ]),
    },
    category: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 4, name: 'Tornillería', isActive: true, parent: null },
        ]),
    },
    warehouse: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    alert: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 9,
          severity: 3,
          productWarehouse: {
            product: { id: 1, sku: 'TOR-001', name: 'Tornillo' },
            warehouse: north,
          },
        },
      ]),
    },
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 5, accountId: 50, jobTitle: null, isActive: true },
        ]),
    },
  };
  const control = {
    organizationMember: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { account: { id: 50, name: 'Toribio', email: 'tori@demo.co' } },
        ]),
    },
  };
  const service = new SearchService(
    { client: () => tenant } as unknown as TenantPrismaService,
    control as unknown as ControlPrismaService,
  );
  return { service, tenant, control };
}

describe('SearchService', () => {
  it('answers every group, with the totals, for the Owner', async () => {
    const { service, tenant } = setup();
    const result = await service.search(owner, { q: 'tor' });

    expect(result.query).toBe('tor');
    expect(result.products).toEqual({
      total: 7,
      items: [{ id: 1, sku: 'TOR-001', name: 'Tornillo', category: 'Tor' }],
    });
    expect(result.categories?.items[0]).toEqual({
      id: 4,
      name: 'Tornillería',
      isActive: true,
      parent: null,
    });
    expect(result.alerts?.items[0]).toEqual({
      id: 9,
      severity: 3,
      product: { id: 1, sku: 'TOR-001', name: 'Tornillo' },
      warehouse: north,
    });
    expect(result.users).toEqual({
      total: 1,
      items: [
        {
          id: 5,
          name: 'Toribio',
          email: 'tori@demo.co',
          jobTitle: null,
          isActive: true,
        },
      ],
    });
    // Five per group by default.
    expect(tenant.product.findMany.mock.calls[0][0].take).toBe(5);
  });

  it('leaves out the groups the user cannot read', async () => {
    const { service, tenant, control } = setup();
    const clerk = authWith([role(['warehouse.read'], north)]);
    const result = await service.search(clerk, { q: 'tor', limit: 3 });

    expect(result.products).toBeNull();
    expect(result.categories).toBeNull();
    expect(result.alerts).toBeNull();
    expect(result.users).toBeNull();
    expect(tenant.product.count).not.toHaveBeenCalled();
    expect(control.organizationMember.findMany).not.toHaveBeenCalled();
    const where = tenant.warehouse.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: [3] });
    expect(tenant.warehouse.findMany.mock.calls[0][0].take).toBe(3);
  });

  it('narrows alerts and users to the warehouses that grant them', async () => {
    const { service, tenant } = setup();
    const lead = authWith([role(['alert.read', 'user.read'], north)]);
    await service.search(lead, { q: 'tor' });

    const alertWhere = tenant.alert.findMany.mock.calls[0][0].where;
    expect(alertWhere.status).toBe('OPEN');
    expect(alertWhere.productWarehouse.warehouseId).toEqual({ in: [3] });
    const userWhere = tenant.user.findMany.mock.calls[0][0].where;
    expect(userWhere.AND[1]).toEqual({
      OR: [
        { id: 1 },
        { roleAssignments: { some: { warehouseId: { in: [3] } } } },
      ],
    });
  });

  it('skips the tenant users when no member matches', async () => {
    const { service, tenant, control } = setup();
    control.organizationMember.findMany.mockResolvedValue([]);
    const result = await service.search(owner, { q: 'zz' });

    expect(result.users).toEqual({ items: [], total: 0 });
    expect(tenant.user.findMany).not.toHaveBeenCalled();
  });
});
