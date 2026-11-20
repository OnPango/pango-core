import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { UserStatusFilter } from './dto.js';
import { UsersService } from './users.service.js';

const ownerRole = { id: 1, name: 'Owner', isSystem: true };
const adminRole = { id: 2, name: 'Admin', isSystem: false };
const operatorRole = { id: 3, name: 'Operator', isSystem: false };

const ADMIN_PERMISSIONS = ['user.read', 'user.manage', 'stock.read'];
const OPERATOR_PERMISSIONS = ['stock.read'];
const PERMISSIONS_BY_ROLE: Record<number, string[]> = {
  2: ADMIN_PERMISSIONS,
  3: OPERATOR_PERMISSIONS,
};

const north = { id: 10, name: 'North' };
const south = { id: 20, name: 'South' };

function grant(
  role: typeof ownerRole,
  warehouse: { id: number; name: string } | null,
  permissions: string[],
): RoleGrant {
  return { ...role, warehouse, permissions };
}

function authAs(roles: RoleGrant[], userId = 1): AuthContext {
  return {
    account: { id: 100, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: { id: userId, jobTitle: null, roles },
  };
}

const owner = authAs([grant(ownerRole, null, ['user.manage', 'user.read'])]);
const northAdmin = authAs([grant(adminRole, north, ADMIN_PERMISSIONS)]);

function assignment(
  id: number,
  userId: number,
  role: typeof ownerRole,
  warehouse: { id: number; name: string } | null,
) {
  return {
    id,
    userId,
    roleId: role.id,
    warehouseId: warehouse?.id ?? null,
    role: {
      ...role,
      permissions: (PERMISSIONS_BY_ROLE[role.id] ?? []).map((code) => ({
        permission: { code },
      })),
    },
    warehouse,
  };
}

function tenantUser(
  id: number,
  assignments: ReturnType<typeof assignment>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    accountId: 100 + id,
    departmentId: null,
    jobTitle: null,
    isActive: true,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    department: null,
    roleAssignments: assignments,
    ...overrides,
  };
}

const northOperator = tenantUser(5, [assignment(50, 5, operatorRole, north)]);
const ownerUser = tenantUser(2, [assignment(20, 2, ownerRole, null)]);

function roleWithPermissions(role: typeof ownerRole, codes: string[]) {
  return {
    ...role,
    permissions: codes.map((code) => ({ permission: { code } })),
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
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    role: { findUnique: vi.fn() },
    warehouse: {
      findUnique: vi.fn().mockResolvedValue({ id: 10, isActive: true }),
    },
    department: { findUnique: vi.fn() },
    roleAssignment: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const control = {
    organizationMember: {
      findMany: vi.fn(
        ({ where }: { where: { accountId?: { in: number[] } } }) =>
          Promise.resolve(
            (where.accountId?.in ?? []).map((accountId) => ({
              accountId,
              joinedAt: null,
              account: {
                email: `user${accountId}@demo.co`,
                name: `User ${accountId}`,
              },
            })),
          ),
      ),
    },
    refreshToken: { updateMany: vi.fn() },
  };
  const service = new UsersService(
    control as unknown as ControlPrismaService,
    { client: () => tenant } as unknown as TenantPrismaService,
  );
  return { tenant, control, service };
}

describe('UsersService.list', () => {
  it('shows a warehouse admin only the users of their warehouses', async () => {
    const { tenant, service } = setup();
    tenant.user.findMany.mockResolvedValue([northOperator]);

    const users = await service.list(northAdmin, {
      status: UserStatusFilter.ACTIVE,
    });

    expect(tenant.user.findMany.mock.calls[0]?.[0].where).toEqual({
      AND: [
        { isActive: true },
        {
          OR: [
            { id: 1 },
            { roleAssignments: { some: { warehouseId: { in: [10] } } } },
          ],
        },
      ],
    });
    expect(users[0]).toMatchObject({
      id: 5,
      isOwner: false,
      roles: [{ assignmentId: 50, id: 3, warehouse: north }],
    });
  });

  it('shows the Owner every user and filters by warehouse', async () => {
    const { tenant, service } = setup();
    await service.list(owner, { warehouseId: 20 });
    expect(tenant.user.findMany.mock.calls[0]?.[0].where).toEqual({
      AND: [{ roleAssignments: { some: { warehouseId: 20 } } }],
    });
  });
});

describe('UsersService.get', () => {
  it('hides users outside the admin warehouses', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(
      tenantUser(6, [assignment(60, 6, operatorRole, south)]),
    );
    expect(await errorCode(service.get(northAdmin, 6))).toBe('USER_NOT_FOUND');
  });
});

describe('UsersService.update', () => {
  it('needs user.manage on every warehouse of the user', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(
      tenantUser(7, [
        assignment(70, 7, operatorRole, north),
        assignment(71, 7, operatorRole, south),
      ]),
    );
    expect(
      await errorCode(service.update(northAdmin, 7, { jobTitle: 'x' })),
    ).toBe('FORBIDDEN');
  });

  it('lets an admin edit a user of their warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.user.update.mockResolvedValue(northOperator);
    await service.update(northAdmin, 5, { jobTitle: '' });
    expect(tenant.user.update.mock.calls[0]?.[0]).toMatchObject({
      data: { jobTitle: null },
    });
  });
});

describe('UsersService.addAssignment', () => {
  it('lets an admin grant a lower role on their warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(operatorRole, OPERATOR_PERMISSIONS),
    );

    await service.addAssignment(northAdmin, 5, { roleId: 3, warehouseId: 10 });

    expect(tenant.roleAssignment.create).toHaveBeenCalledWith({
      data: { userId: 5, roleId: 3, warehouseId: 10 },
    });
  });

  it('does not let an admin grant their own level', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValueOnce(
      roleWithPermissions(adminRole, ADMIN_PERMISSIONS),
    );
    expect(
      await errorCode(
        service.addAssignment(northAdmin, 5, { roleId: 2, warehouseId: 10 }),
      ),
    ).toBe('ROLE_NOT_BELOW_YOURS');

    // A different role with the same permissions is the same level too.
    tenant.role.findUnique.mockResolvedValueOnce(
      roleWithPermissions({ ...adminRole, id: 9 }, ADMIN_PERMISSIONS),
    );
    expect(
      await errorCode(
        service.addAssignment(northAdmin, 5, { roleId: 9, warehouseId: 10 }),
      ),
    ).toBe('ROLE_NOT_BELOW_YOURS');
  });

  it('rejects another warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(operatorRole, OPERATOR_PERMISSIONS),
    );
    expect(
      await errorCode(
        service.addAssignment(northAdmin, 5, { roleId: 3, warehouseId: 20 }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('rejects a role with permissions the admin lacks', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(adminRole, [...ADMIN_PERMISSIONS, 'role.manage']),
    );
    expect(
      await errorCode(
        service.addAssignment(northAdmin, 5, { roleId: 2, warehouseId: 10 }),
      ),
    ).toBe('ROLE_NOT_BELOW_YOURS');
  });

  it('only lets the Owner grant Owner, and only on every warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(ownerRole, ADMIN_PERMISSIONS),
    );
    expect(
      await errorCode(service.addAssignment(northAdmin, 5, { roleId: 1 })),
    ).toBe('FORBIDDEN');
    expect(
      await errorCode(
        service.addAssignment(owner, 5, { roleId: 1, warehouseId: 10 }),
      ),
    ).toBe('ASSIGNMENT_SCOPE_INVALID');
  });

  it('needs a warehouse for roles other than Owner', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(operatorRole, OPERATOR_PERMISSIONS),
    );
    expect(
      await errorCode(service.addAssignment(owner, 5, { roleId: 3 })),
    ).toBe('ASSIGNMENT_SCOPE_INVALID');
  });

  it('rejects a duplicate assignment', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.role.findUnique.mockResolvedValue(
      roleWithPermissions(operatorRole, OPERATOR_PERMISSIONS),
    );
    tenant.roleAssignment.findFirst.mockResolvedValue({ id: 50 });
    expect(
      await errorCode(
        service.addAssignment(northAdmin, 5, { roleId: 3, warehouseId: 10 }),
      ),
    ).toBe('DUPLICATE_ROLE_ASSIGNMENT');
  });
});

describe('UsersService.removeAssignment', () => {
  it('keeps the last active Owner', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(ownerUser);
    tenant.roleAssignment.findFirst.mockResolvedValue({
      ...assignment(20, 2, ownerRole, null),
      role: roleWithPermissions(ownerRole, []),
    });
    tenant.user.count.mockResolvedValue(0);
    expect(await errorCode(service.removeAssignment(owner, 2, 20))).toBe(
      'LAST_OWNER',
    );
    expect(tenant.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT "id" FROM "tenant_demo"."roles" WHERE "is_system" FOR UPDATE',
    );
  });

  it('lets an admin remove a role on their warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.roleAssignment.findFirst.mockResolvedValue({
      ...assignment(50, 5, operatorRole, north),
      role: roleWithPermissions(operatorRole, OPERATOR_PERMISSIONS),
    });
    await service.removeAssignment(northAdmin, 5, 50);
    expect(tenant.roleAssignment.delete).toHaveBeenCalledWith({
      where: { id: 50 },
    });
  });

  it('does not let an admin change an Owner', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(
      tenantUser(2, [
        assignment(20, 2, ownerRole, null),
        assignment(21, 2, operatorRole, north),
      ]),
    );
    expect(await errorCode(service.removeAssignment(northAdmin, 2, 21))).toBe(
      'FORBIDDEN',
    );
  });

  it('returns 404 for an assignment of another user', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    expect(await errorCode(service.removeAssignment(owner, 5, 99))).toBe(
      'ROLE_ASSIGNMENT_NOT_FOUND',
    );
  });
});

describe('UsersService.deactivate', () => {
  it('does not let users deactivate themselves', async () => {
    const { service } = setup();
    expect(await errorCode(service.deactivate(owner, 1))).toBe(
      'SELF_DEACTIVATION',
    );
  });

  it('does not let an admin deactivate another admin of their warehouse', async () => {
    const { tenant, service } = setup();
    const peer = tenantUser(8, [assignment(80, 8, adminRole, north)]);
    tenant.user.findUnique.mockResolvedValue(peer);
    tenant.user.findUniqueOrThrow.mockResolvedValue(peer);
    expect(await errorCode(service.deactivate(northAdmin, 8))).toBe(
      'ROLE_NOT_BELOW_YOURS',
    );
  });

  it('does not let an admin deactivate an Owner', async () => {
    const { tenant, service } = setup();
    // The Owner is visible to the admin because they share the North warehouse.
    const shared = tenantUser(2, [
      assignment(20, 2, ownerRole, null),
      assignment(21, 2, operatorRole, north),
    ]);
    tenant.user.findUnique.mockResolvedValue(shared);
    tenant.user.findUniqueOrThrow.mockResolvedValue(shared);
    expect(await errorCode(service.deactivate(northAdmin, 2))).toBe(
      'FORBIDDEN',
    );
  });

  it('keeps the last active Owner', async () => {
    const { tenant, control, service } = setup();
    tenant.user.findUnique.mockResolvedValue(ownerUser);
    tenant.user.findUniqueOrThrow.mockResolvedValue(ownerUser);
    tenant.user.update.mockResolvedValue({ ...ownerUser, isActive: false });
    tenant.user.count.mockResolvedValue(0);
    expect(await errorCode(service.deactivate(owner, 2))).toBe('LAST_OWNER');
    expect(control.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('deactivates a user of the admin warehouse and ends their sessions', async () => {
    const { tenant, control, service } = setup();
    tenant.user.findUnique.mockResolvedValue(northOperator);
    tenant.user.findUniqueOrThrow.mockResolvedValue(northOperator);
    tenant.user.update.mockResolvedValue({ ...northOperator, isActive: false });

    const user = await service.deactivate(northAdmin, 5);

    expect(user.isActive).toBe(false);
    expect(control.refreshToken.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { accountId: 105, organizationId: 10, revokedAt: null },
    });
  });
});

describe('UsersService.activate', () => {
  it('reactivates an inactive user', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue({
      ...northOperator,
      isActive: false,
    });
    tenant.user.update.mockResolvedValue(northOperator);
    expect((await service.activate(northAdmin, 5)).isActive).toBe(true);
  });
});
