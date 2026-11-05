import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { catalogErrors } from './catalog-errors.js';
import {
  CatalogStatusFilter,
  type CreateCategoryDto,
  type ListCategoriesQueryDto,
  type UpdateCategoryDto,
} from './dto.js';
import type { CategoryDto } from './responses.js';

type Tx = Prisma.TransactionClient;

const categoryInclude = {
  _count: { select: { products: true } },
} satisfies Prisma.CategoryInclude;

type CategoryWithCount = Prisma.CategoryGetPayload<{
  include: typeof categoryInclude;
}>;

function toDto(category: CategoryWithCount): CategoryDto {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    parentId: category.parentId,
    isActive: category.isActive,
    productCount: category._count.products,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

// CU-03 A3: product families, as a tree. The list is flat (each row has its
// parentId) so the client builds the tree. Categories are deactivated, not deleted.
@Injectable()
export class CategoriesService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async list(
    auth: AuthContext,
    query: ListCategoriesQueryDto,
  ): Promise<CategoryDto[]> {
    const status = query.status ?? CatalogStatusFilter.ALL;
    const where: Prisma.CategoryWhereInput = {};
    if (status === CatalogStatusFilter.ACTIVE) where.isActive = true;
    if (status === CatalogStatusFilter.INACTIVE) where.isActive = false;
    const categories = await this.tenant(auth).category.findMany({
      where,
      include: categoryInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return categories.map(toDto);
  }

  async get(auth: AuthContext, id: number): Promise<CategoryDto> {
    const category = await this.tenant(auth).category.findUnique({
      where: { id },
      include: categoryInclude,
    });
    if (!category) throw catalogErrors.categoryNotFound();
    return toDto(category);
  }

  async create(
    auth: AuthContext,
    dto: CreateCategoryDto,
  ): Promise<CategoryDto> {
    const tenant = this.tenant(auth);
    const parentId = dto.parentId ?? null;
    if (parentId !== null) await this.assertParentUsable(tenant, parentId);
    await this.assertNameFree(tenant, dto.name, parentId);

    const category = await tenant.category.create({
      data: { name: dto.name, parentId, description: dto.description || null },
      include: categoryInclude,
    });
    return toDto(category);
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    const tenant = this.tenant(auth);
    const category = await tenant.category.findUnique({ where: { id } });
    if (!category) throw catalogErrors.categoryNotFound();

    const parentId =
      dto.parentId === undefined ? category.parentId : dto.parentId;
    const isActive = dto.isActive ?? category.isActive;
    const name = dto.name ?? category.name;

    if (parentId !== category.parentId && parentId !== null) {
      await this.assertNoCycle(tenant, id, parentId);
    }
    // An active category needs an active parent (moved, reactivated or both).
    if (
      parentId !== null &&
      isActive &&
      (parentId !== category.parentId || !category.isActive)
    ) {
      await this.assertParentUsable(tenant, parentId);
    }
    if (name !== category.name || parentId !== category.parentId) {
      await this.assertNameFree(tenant, name, parentId, id);
    }
    if (!isActive && category.isActive) {
      const activeChildren = await tenant.category.count({
        where: { parentId: id, isActive: true },
      });
      if (activeChildren > 0) throw catalogErrors.categoryHasActiveChildren();
    }

    const updated = await tenant.category.update({
      where: { id },
      data: {
        name,
        parentId,
        isActive,
        ...(dto.description === undefined
          ? {}
          : { description: dto.description || null }),
      },
      include: categoryInclude,
    });
    return toDto(updated);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  private async assertParentUsable(tenant: Tx, parentId: number) {
    const parent = await tenant.category.findUnique({
      where: { id: parentId },
    });
    if (!parent?.isActive) throw catalogErrors.categoryParentInvalid();
  }

  /** The new parent must not be the category itself or one of its descendants. */
  private async assertNoCycle(tenant: Tx, id: number, parentId: number) {
    const categories = await tenant.category.findMany({
      select: { id: true, parentId: true },
    });
    const parents = new Map(categories.map((c) => [c.id, c.parentId]));
    if (!parents.has(parentId)) throw catalogErrors.categoryParentInvalid();
    const seen = new Set<number>();
    for (
      let current: number | null | undefined = parentId;
      current != null && !seen.has(current);
      current = parents.get(current)
    ) {
      if (current === id) throw catalogErrors.categoryCycle();
      seen.add(current);
    }
  }

  private async assertNameFree(
    tenant: Tx,
    name: string,
    parentId: number | null,
    exceptId?: number,
  ) {
    const existing = await tenant.category.findFirst({
      where: {
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (existing) throw catalogErrors.categoryNameTaken();
  }
}
