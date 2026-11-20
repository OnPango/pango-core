import type { HttpException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { CategoriesService } from './categories.service.js';

const auth = {
  organization: { schemaName: 'tenant_demo' },
} as unknown as AuthContext;

function category(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Hardware',
    description: null,
    parentId: null,
    isActive: true,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    _count: { products: 0 },
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
    category: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(category()),
      update: vi.fn().mockResolvedValue(category()),
    },
  };
  const service = new CategoriesService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

describe('CategoriesService.create', () => {
  it('rejects an inactive parent', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique.mockResolvedValue(category({ isActive: false }));
    expect(
      await errorCode(service.create(auth, { name: 'Bolts', parentId: 1 })),
    ).toBe('CATEGORY_PARENT_INVALID');
  });

  it('rejects a name already used among its siblings', async () => {
    const { tenant, service } = setup();
    tenant.category.findFirst.mockResolvedValue({ id: 2 });
    expect(await errorCode(service.create(auth, { name: 'hardware' }))).toBe(
      'CATEGORY_NAME_TAKEN',
    );
    expect(tenant.category.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      parentId: null,
      name: { equals: 'hardware', mode: 'insensitive' },
    });
  });

  it('creates a top-level category', async () => {
    const { tenant, service } = setup();
    await service.create(auth, { name: 'Hardware', description: '' });
    expect(tenant.category.create.mock.calls[0]?.[0].data).toEqual({
      name: 'Hardware',
      parentId: null,
      description: null,
    });
  });
});

describe('CategoriesService.update', () => {
  it('does not move a category under one of its descendants', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique.mockResolvedValue(category({ id: 1 }));
    tenant.category.findMany.mockResolvedValue([
      { id: 1, parentId: null },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
    ]);
    expect(await errorCode(service.update(auth, 1, { parentId: 3 }))).toBe(
      'CATEGORY_CYCLE',
    );
    expect(await errorCode(service.update(auth, 1, { parentId: 1 }))).toBe(
      'CATEGORY_CYCLE',
    );
  });

  it('does not deactivate a category with active subcategories', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique.mockResolvedValue(category());
    tenant.category.count.mockResolvedValue(1);
    expect(await errorCode(service.update(auth, 1, { isActive: false }))).toBe(
      'CATEGORY_HAS_ACTIVE_CHILDREN',
    );
  });

  it('does not reactivate a category under an inactive parent', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique
      .mockResolvedValueOnce(category({ id: 2, parentId: 1, isActive: false }))
      .mockResolvedValueOnce(category({ id: 1, isActive: false }));
    expect(await errorCode(service.update(auth, 2, { isActive: true }))).toBe(
      'CATEGORY_PARENT_INVALID',
    );
  });

  it('moves a category to the top level', async () => {
    const { tenant, service } = setup();
    tenant.category.findUnique.mockResolvedValue(
      category({ id: 2, parentId: 1 }),
    );
    await service.update(auth, 2, { parentId: null });
    expect(tenant.category.update.mock.calls[0]?.[0].data).toMatchObject({
      parentId: null,
    });
    expect(tenant.category.findFirst.mock.calls[0]?.[0].where).toMatchObject({
      parentId: null,
      id: { not: 2 },
    });
  });
});
