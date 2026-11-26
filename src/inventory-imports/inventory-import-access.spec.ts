import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import {
  assignCreatorToWarehouse,
  importScope,
  INVENTORY_IMPORT,
  mayImportInto,
  rolesForNewWarehouse,
} from './inventory-import-access.js';

function role(
  id: number,
  permissions: string[],
  warehouse: { id: number; name: string } | null,
  isSystem = false,
): RoleGrant {
  return { id, name: `Role ${id}`, isSystem, warehouse, permissions };
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
    user: { id: 7, jobTitle: null, roles },
  };
}

const north = { id: 1, name: 'North' };
const south = { id: 2, name: 'South' };
const owner = authWith([
  role(1, [INVENTORY_IMPORT, 'role.manage'], null, true),
]);
const admin = authWith([
  role(2, [INVENTORY_IMPORT, 'stock.read'], north),
  role(2, [INVENTORY_IMPORT, 'stock.read'], south),
]);

describe('importScope and mayImportInto', () => {
  it('lets the Owner import into every warehouse', () => {
    expect(importScope(owner)).toBe('ALL');
    expect(mayImportInto(importScope(owner), 99)).toBe(true);
  });

  it('limits other roles to the warehouses where they hold the permission', () => {
    const scope = importScope(admin);
    expect(scope).toEqual([1, 2]);
    expect(mayImportInto(scope, 1)).toBe(true);
    expect(mayImportInto(scope, 3)).toBe(false);
  });

  it('treats a custom role like any other role', () => {
    const importer = authWith([
      role(9, [INVENTORY_IMPORT], south),
      role(4, ['stock.read', 'movement.create'], north),
    ]);
    expect(importScope(importer)).toEqual([2]);
    expect(mayImportInto(importScope(importer), 1)).toBe(false);
  });

  it('gives nothing to a role without the permission, such as Operator', () => {
    const operator = authWith([
      role(3, ['stock.read', 'movement.create'], north),
    ]);
    expect(importScope(operator)).toEqual([]);
    expect(mayImportInto(importScope(operator), 1)).toBe(false);
  });
});

describe('rolesForNewWarehouse', () => {
  it('assigns nothing to the Owner', () => {
    expect(rolesForNewWarehouse(owner)).toEqual([]);
  });

  it('returns each role that grants the permission once, and only those', () => {
    const user = authWith([
      role(5, [INVENTORY_IMPORT], north),
      role(5, [INVENTORY_IMPORT], south),
      role(2, [INVENTORY_IMPORT, 'user.manage'], north),
      role(3, ['stock.read'], south),
    ]);
    expect(rolesForNewWarehouse(user)).toEqual([2, 5]);
  });
});

describe('assignCreatorToWarehouse', () => {
  it('creates the assignments, skipping existing ones', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { roleAssignment: { createMany } };
    const user = authWith([
      role(5, [INVENTORY_IMPORT], north),
      role(2, [INVENTORY_IMPORT], north),
    ]);

    await expect(assignCreatorToWarehouse(tx as never, user, 30)).resolves.toBe(
      2,
    );
    expect(createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        { userId: 7, roleId: 2, warehouseId: 30 },
        { userId: 7, roleId: 5, warehouseId: 30 },
      ],
      skipDuplicates: true,
    });
  });

  it('writes nothing for the Owner', async () => {
    const createMany = vi.fn();
    const tx = { roleAssignment: { createMany } };

    await expect(
      assignCreatorToWarehouse(tx as never, owner, 30),
    ).resolves.toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});
