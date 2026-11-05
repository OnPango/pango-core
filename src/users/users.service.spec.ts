import type { HttpException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { UserStatusFilter } from './dto.js';
import { UsersService } from './users.service.js';

const owner = { id: 1, name: 'Owner', isSystem: true };
const operator = { id: 2, name: 'Operator', isSystem: false };

function authAs(isAdmin: boolean): AuthContext {
  return {
    account: { id: 100, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: {
      id: 1,
      jobTitle: null,
      roles: [
        {
          ...(isAdmin ? owner : operator),
          warehouse: null,
          permissions: ['user.manage', 'user.read'],
        },
      ],
    },
  };
}

function tenantUser(
  id: number,
  role: typeof owner | typeof operator,
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
    roleAssignments: [
      {
        id,
        userId: id,
        roleId: role.id,
        warehouseId: null,
        role,
        warehouse: null,
      },
    ],
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
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    role: { findMany: vi.fn() },
    warehouse: { count: vi.fn() },
    department: { findUnique: vi.fn() },
    roleAssignment: { deleteMany: vi.fn(), createMany: vi.fn() },
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
  it('filters by status and role, and searches accounts in the organization', async () => {
    const { tenant, control, service } = setup();
    control.organizationMember.findMany.mockResolvedValueOnce([
      { accountId: 102 },
    ] as never);
    tenant.user.findMany.mockResolvedValue([tenantUser(2, operator)]);

    const users = await service.list(authAs(true), {
      search: 'carlos',
      status: UserStatusFilter.ACTIVE,
      roleId: 2,
    });

    expect(
      control.organizationMember.findMany.mock.calls[0]?.[0],
    ).toMatchObject({
      where: { organizationId: 10 },
    });
    expect(tenant.user.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        isActive: true,
        accountId: { in: [102] },
        roleAssignments: { some: { roleId: 2 } },
      },
    });
    expect(users).toMatchObject([
      { id: 2, email: 'user102@demo.co', isAdmin: false, roles: [{ id: 2 }] },
    ]);
  });

  it('leaves out tenant users without a membership', async () => {
    const { tenant, control, service } = setup();
    tenant.user.findMany.mockResolvedValue([tenantUser(2, operator)]);
    control.organizationMember.findMany.mockResolvedValueOnce([] as never);
    expect(await service.list(authAs(true), {})).toEqual([]);
  });
});

describe('UsersService.update', () => {
  it('rejects an inactive department', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.department.findUnique.mockResolvedValue({ id: 4, isActive: false });
    expect(
      await errorCode(service.update(authAs(true), 2, { departmentId: 4 })),
    ).toBe('DEPARTMENT_NOT_FOUND');
  });

  it('stores an empty job title as null', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.user.update.mockResolvedValue(tenantUser(2, operator));
    await service.update(authAs(true), 2, { jobTitle: '' });
    expect(tenant.user.update.mock.calls[0]?.[0]).toMatchObject({
      data: { jobTitle: null },
    });
  });

  it('does not let a non-administrator change an administrator', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, owner));
    expect(
      await errorCode(service.update(authAs(false), 2, { jobTitle: 'x' })),
    ).toBe('FORBIDDEN');
  });
});

describe('UsersService.setRoles', () => {
  it('rejects duplicate assignments', async () => {
    const { service } = setup();
    expect(
      await errorCode(
        service.setRoles(authAs(true), 2, {
          roles: [{ roleId: 2 }, { roleId: 2 }],
        }),
      ),
    ).toBe('DUPLICATE_ROLE_ASSIGNMENT');
  });

  it('only lets administrators grant system roles', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.role.findMany.mockResolvedValue([owner]);
    expect(
      await errorCode(
        service.setRoles(authAs(false), 2, { roles: [{ roleId: 1 }] }),
      ),
    ).toBe('FORBIDDEN');
    expect(tenant.roleAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown role or an inactive warehouse', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.role.findMany.mockResolvedValue([]);
    expect(
      await errorCode(
        service.setRoles(authAs(true), 2, { roles: [{ roleId: 9 }] }),
      ),
    ).toBe('ROLE_NOT_FOUND');

    tenant.role.findMany.mockResolvedValue([operator]);
    tenant.warehouse.count.mockResolvedValue(0);
    expect(
      await errorCode(
        service.setRoles(authAs(true), 2, {
          roles: [{ roleId: 2, warehouseId: 5 }],
        }),
      ),
    ).toBe('WAREHOUSE_NOT_FOUND');
  });

  it('fails when the change would leave no administrator', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(1, owner));
    tenant.role.findMany.mockResolvedValue([operator]);
    tenant.user.count.mockResolvedValue(0);
    expect(
      await errorCode(
        service.setRoles(authAs(true), 1, { roles: [{ roleId: 2 }] }),
      ),
    ).toBe('LAST_ADMIN');
    expect(tenant.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT "id" FROM "tenant_demo"."roles" WHERE "is_system" FOR UPDATE',
    );
  });

  it('replaces the assignments', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.role.findMany.mockResolvedValue([operator]);
    tenant.warehouse.count.mockResolvedValue(1);
    tenant.user.findUniqueOrThrow.mockResolvedValue(tenantUser(2, operator));

    await service.setRoles(authAs(true), 2, {
      roles: [{ roleId: 2, warehouseId: 3 }],
    });

    expect(tenant.roleAssignment.deleteMany).toHaveBeenCalledWith({
      where: { userId: 2 },
    });
    expect(tenant.roleAssignment.createMany).toHaveBeenCalledWith({
      data: [{ userId: 2, roleId: 2, warehouseId: 3 }],
    });
  });
});

describe('UsersService.deactivate', () => {
  it('does not let users deactivate themselves', async () => {
    const { service } = setup();
    expect(await errorCode(service.deactivate(authAs(true), 1))).toBe(
      'SELF_DEACTIVATION',
    );
  });

  it('keeps the last active administrator', async () => {
    const { tenant, control, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, owner));
    tenant.user.update.mockResolvedValue(
      tenantUser(2, owner, { isActive: false }),
    );
    tenant.user.count.mockResolvedValue(0);
    expect(await errorCode(service.deactivate(authAs(true), 2))).toBe(
      'LAST_ADMIN',
    );
    expect(control.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('deactivates the user and revokes their sessions in the organization', async () => {
    const { tenant, control, service } = setup();
    tenant.user.findUnique.mockResolvedValue(tenantUser(2, operator));
    tenant.user.update.mockResolvedValue(
      tenantUser(2, operator, { isActive: false }),
    );

    const user = await service.deactivate(authAs(true), 2);

    expect(user.isActive).toBe(false);
    expect(tenant.user.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 2 },
      data: { isActive: false },
    });
    expect(control.refreshToken.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { accountId: 102, organizationId: 10, revokedAt: null },
    });
  });

  it('returns 404 for an unknown user', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(null);
    expect(await errorCode(service.deactivate(authAs(true), 9))).toBe(
      'USER_NOT_FOUND',
    );
  });
});

describe('UsersService.activate', () => {
  it('reactivates an inactive user', async () => {
    const { tenant, service } = setup();
    tenant.user.findUnique.mockResolvedValue(
      tenantUser(2, operator, { isActive: false }),
    );
    tenant.user.update.mockResolvedValue(tenantUser(2, operator));
    expect((await service.activate(authAs(true), 2)).isActive).toBe(true);
  });
});
