import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import {
  grantedPermissions,
  isOwner,
  permissionsInWarehouse,
} from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { RolesService } from './roles.service.js';

function grant(
  id: number,
  isSystem: boolean,
  warehouse: { id: number; name: string } | null,
  permissions: string[],
): RoleGrant {
  return { id, name: `Role ${id}`, isSystem, warehouse, permissions };
}

function authAs(roles: RoleGrant[]): AuthContext {
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

const owner = authAs([grant(1, true, null, ['role.manage'])]);
const roleManager = authAs([
  grant(2, false, { id: 10, name: 'North' }, ['role.manage', 'stock.read']),
]);

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: 'Operator',
    description: null,
    isSystem: false,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    permissions: [{ permission: { code: 'stock.read' } }],
    _count: { assignments: 0 },
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
    role: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(role()),
      findUniqueOrThrow: vi.fn().mockResolvedValue(role()),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 3 }),
      update: vi.fn(),
      delete: vi.fn(),
    },
    permission: {
      findMany: vi.fn(({ where }: { where: { code: { in: string[] } } }) =>
        Promise.resolve(
          where.code.in
            .filter((code) => code !== 'nope')
            .map((code, i) => ({ id: i + 1, code })),
        ),
      ),
    },
    rolePermission: { createMany: vi.fn(), deleteMany: vi.fn() },
    movementType: { findMany: vi.fn().mockResolvedValue([{ id: 1 }]) },
    roleMovementType: { createMany: vi.fn() },
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const control = {
    organizationInvitation: { count: vi.fn().mockResolvedValue(0) },
  };
  const service = new RolesService(
    control as unknown as ControlPrismaService,
    { client: () => tenant } as unknown as TenantPrismaService,
  );
  return { tenant, control, service };
}

describe('permission helpers', () => {
  const roles = [
    grant(2, false, { id: 10, name: 'North' }, ['user.manage']),
    grant(3, false, { id: 20, name: 'South' }, ['stock.read']),
  ];

  it('scopes warehouse permissions to the warehouse that grants them', () => {
    expect([...permissionsInWarehouse(roles, 10)]).toEqual(['user.manage']);
    expect([...permissionsInWarehouse(roles, 20)]).toEqual(['stock.read']);
    expect(grantedPermissions(roles).has('stock.read')).toBe(true);
    expect(isOwner(roles)).toBe(false);
  });
});

describe('RolesService.create', () => {
  it('creates the role with its permissions and every movement type', async () => {
    const { tenant, service } = setup();
    await service.create(owner, {
      name: 'Clerk',
      permissions: ['stock.read', 'movement.create'],
    });
    expect(tenant.rolePermission.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: 3, permissionId: 1 },
        { roleId: 3, permissionId: 2 },
      ],
    });
    expect(tenant.roleMovementType.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 3, movementTypeId: 1 }],
    });
  });

  it('rejects unknown permissions', async () => {
    const { service } = setup();
    expect(
      await errorCode(
        service.create(owner, { name: 'Clerk', permissions: ['nope'] }),
      ),
    ).toBe('PERMISSION_NOT_FOUND');
  });

  it('does not let a non-owner give permissions they lack', async () => {
    const { service } = setup();
    expect(
      await errorCode(
        service.create(roleManager, {
          name: 'Clerk',
          permissions: ['user.manage'],
        }),
      ),
    ).toBe('ROLE_EXCEEDS_YOUR_PERMISSIONS');
  });

  it('rejects a taken name, ignoring case', async () => {
    const { tenant, service } = setup();
    tenant.role.findFirst.mockResolvedValue({ id: 9 });
    expect(
      await errorCode(
        service.create(owner, { name: 'operator', permissions: [] }),
      ),
    ).toBe('ROLE_NAME_TAKEN');
  });
});

describe('RolesService.update', () => {
  it('locks system roles', async () => {
    const { tenant, service } = setup();
    tenant.role.findUnique.mockResolvedValue(role({ isSystem: true }));
    expect(await errorCode(service.update(owner, 1, { name: 'x' }))).toBe(
      'ROLE_SYSTEM_LOCKED',
    );
  });

  it('does not let a non-owner edit a role they hold', async () => {
    const { tenant, service } = setup();
    tenant.role.findUnique.mockResolvedValue(role({ id: 2 }));
    expect(
      await errorCode(service.update(roleManager, 2, { permissions: [] })),
    ).toBe('ROLE_HELD_BY_YOU');
  });

  it('replaces the permissions', async () => {
    const { tenant, service } = setup();
    await service.update(owner, 3, { permissions: ['catalog.read'] });
    expect(tenant.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: { roleId: 3 },
    });
    expect(tenant.rolePermission.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 3, permissionId: 1 }],
    });
  });
});

describe('RolesService.remove', () => {
  it('rejects a role with assignments or pending invitations', async () => {
    const { tenant, control, service } = setup();
    tenant.role.findUnique.mockResolvedValueOnce(
      role({ _count: { assignments: 2 } }),
    );
    expect(await errorCode(service.remove(owner, 3))).toBe('ROLE_IN_USE');

    control.organizationInvitation.count.mockResolvedValueOnce(1);
    expect(await errorCode(service.remove(owner, 3))).toBe('ROLE_IN_USE');
    expect(tenant.role.delete).not.toHaveBeenCalled();
  });

  it('deletes an unused role', async () => {
    const { tenant, service } = setup();
    await service.remove(owner, 3);
    expect(tenant.role.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });
});
