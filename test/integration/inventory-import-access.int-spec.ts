import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import {
  assignCreatorToWarehouse,
  INVENTORY_IMPORT,
} from '../../src/inventory-imports/inventory-import-access.js';
import {
  applyMigration,
  createWarehouse,
  provisionTenant,
  sessionFor,
  tenantClient,
} from './database.js';

const MIGRATION = '20261124100000_inventory_import_permission';

/** Permission codes of each role, by role name. */
async function grantsByRole(db: PrismaClient) {
  const roles = await db.role.findMany({
    include: { permissions: { include: { permission: true } } },
  });
  return new Map(
    roles.map((r) => [
      r.name,
      r.permissions.map((p) => p.permission.code).sort(),
    ]),
  );
}

describe('inventory.import permission migration', () => {
  it('gives a new organization the permission on Owner and Admin, not Operator', async () => {
    const tenant = await provisionTenant('perm-new');
    const db = tenantClient(tenant.schema);
    try {
      const permission = await db.permission.findUniqueOrThrow({
        where: { code: INVENTORY_IMPORT },
      });
      expect(permission).toMatchObject({
        module: 'inventory',
        scope: 'WAREHOUSE',
      });

      const grants = await grantsByRole(db);
      expect(grants.get('Owner')).toContain(INVENTORY_IMPORT);
      expect(grants.get('Admin')).toContain(INVENTORY_IMPORT);
      expect(grants.get('Operator')).not.toContain(INVENTORY_IMPORT);
      // The Owner keeps every permission.
      expect(grants.get('Owner')).toHaveLength(await db.permission.count());
    } finally {
      await db.$disconnect();
    }
  });

  it('leaves the custom roles of an existing organization unchanged', async () => {
    const tenant = await provisionTenant('perm-existing', {
      before: MIGRATION,
    });
    const db = tenantClient(tenant.schema);
    try {
      expect(
        await db.permission.findUnique({ where: { code: INVENTORY_IMPORT } }),
      ).toBeNull();
      const stockRead = await db.permission.findUniqueOrThrow({
        where: { code: 'stock.read' },
      });
      await db.role.create({
        data: {
          name: 'Inventory supervisor',
          permissions: { create: [{ permissionId: stockRead.id }] },
        },
      });
      const before = await grantsByRole(db);

      await applyMigration(tenant.schema, MIGRATION);

      const after = await grantsByRole(db);
      expect(after.get('Inventory supervisor')).toEqual(
        before.get('Inventory supervisor'),
      );
      expect(after.get('Operator')).toEqual(before.get('Operator'));
      expect(after.get('Admin')).toEqual(
        [...before.get('Admin')!, INVENTORY_IMPORT].sort(),
      );
      expect(after.get('Owner')).toHaveLength(await db.permission.count());
    } finally {
      await db.$disconnect();
    }
  });
});

describe('assignCreatorToWarehouse', () => {
  it('assigns a non-Owner creator with their importing roles, once', async () => {
    const tenant = await provisionTenant('perm-assign');
    const db = tenantClient(tenant.schema);
    try {
      const north = await createWarehouse(db, 'NORTH');
      const created = await createWarehouse(db, 'SOUTH');
      const [admin, operator] = await Promise.all([
        db.role.findUniqueOrThrow({ where: { name: 'Admin' } }),
        db.role.findUniqueOrThrow({ where: { name: 'Operator' } }),
      ]);
      const user = await db.user.create({ data: { accountId: 900 } });
      await db.roleAssignment.createMany({
        data: [
          { userId: user.id, roleId: admin.id, warehouseId: north.id },
          { userId: user.id, roleId: operator.id, warehouseId: north.id },
        ],
      });
      const auth = await sessionFor(db, tenant, user.id);

      const first = await db.$transaction((tx) =>
        assignCreatorToWarehouse(tx, auth, created.id),
      );
      const again = await db.$transaction((tx) =>
        assignCreatorToWarehouse(tx, auth, created.id),
      );

      expect(first).toBe(1);
      expect(again).toBe(0);
      const inCreated = await db.roleAssignment.findMany({
        where: { userId: user.id, warehouseId: created.id },
      });
      expect(inCreated.map((a) => a.roleId)).toEqual([admin.id]);
    } finally {
      await db.$disconnect();
    }
  });

  it('assigns nothing to the Owner', async () => {
    const tenant = await provisionTenant('perm-owner');
    const db = tenantClient(tenant.schema);
    try {
      const created = await createWarehouse(db, 'NEW');
      const auth = await sessionFor(db, tenant, tenant.userId);

      const count = await db.$transaction((tx) =>
        assignCreatorToWarehouse(tx, auth, created.id),
      );

      expect(count).toBe(0);
      expect(
        await db.roleAssignment.count({ where: { warehouseId: created.id } }),
      ).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
