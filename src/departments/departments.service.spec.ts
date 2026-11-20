import type { HttpException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { DepartmentsService } from './departments.service.js';
import { DepartmentStatusFilter } from './dto.js';

const auth = {
  organization: { schemaName: 'tenant_demo' },
} as unknown as AuthContext;

const stored = {
  id: 4,
  name: 'Production',
  costCenter: null,
  isActive: true,
  _count: { users: 3 },
};

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
    department: {
      findMany: vi.fn().mockResolvedValue([stored]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(stored),
      create: vi.fn().mockResolvedValue(stored),
      update: vi.fn().mockResolvedValue(stored),
    },
  };
  const service = new DepartmentsService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

describe('DepartmentsService', () => {
  it('lists active departments by default', async () => {
    const { tenant, service } = setup();
    const [department] = await service.list(auth, {});
    expect(tenant.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    expect(department.userCount).toBe(3);

    await service.list(auth, { status: DepartmentStatusFilter.ALL });
    expect(tenant.department.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('keeps names unique case-insensitively', async () => {
    const { tenant, service } = setup();
    tenant.department.findFirst.mockResolvedValue({ id: 5 });
    expect(await errorCode(service.create(auth, { name: 'production' }))).toBe(
      'DEPARTMENT_NAME_TAKEN',
    );
    expect(
      await errorCode(service.update(auth, 4, { name: 'production' })),
    ).toBe('DEPARTMENT_NAME_TAKEN');
    expect(tenant.department.findFirst).toHaveBeenLastCalledWith({
      where: {
        name: { equals: 'production', mode: 'insensitive' },
        id: { not: 4 },
      },
      select: { id: true },
    });
  });

  it('answers 404 for an unknown department', async () => {
    const { tenant, service } = setup();
    tenant.department.findUnique.mockResolvedValue(null);
    expect(await errorCode(service.update(auth, 9, { isActive: false }))).toBe(
      'DEPARTMENT_NOT_FOUND',
    );
  });
});
