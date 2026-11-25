import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionTenant, tenantClient } from './database.js';

// Smoke test of the integration harness: an organization provisioned like
// sign-up gets every tenant migration and its base data.
describe('integration database', () => {
  it('provisions a tenant with every migration and the base data', async () => {
    const tenant = await provisionTenant('harness-check');
    const db = tenantClient(tenant.schema);
    try {
      const migrations = (
        await readdir(join(process.cwd(), 'prisma/tenant/migrations'), {
          withFileTypes: true,
        })
      ).filter((entry) => entry.isDirectory()).length;
      const [applied] = await db.$queryRawUnsafe<{ count: number }[]>(
        `SELECT COUNT(*)::int AS "count" FROM "${tenant.schema}"."_prisma_migrations"`,
      );
      expect(applied.count).toBe(migrations);

      const owner = await db.role.findUniqueOrThrow({
        where: { name: 'Owner' },
        include: { assignments: true },
      });
      expect(owner.assignments).toEqual([
        expect.objectContaining({ userId: tenant.userId, warehouseId: null }),
      ]);
      const openingBalance = await db.movementType.findUniqueOrThrow({
        where: { name: 'Opening balance' },
      });
      expect(openingBalance).toMatchObject({
        nature: 'INBOUND',
        countsAsDemand: false,
        isBase: true,
      });
    } finally {
      await db.$disconnect();
    }
  });
});
