import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { isUniqueViolation } from '../prisma/prisma-errors.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { catalogErrors } from './catalog-errors.js';
import {
  CatalogStatusFilter,
  type CreateProductDto,
  type ListProductsQueryDto,
  type UpdateProductDto,
} from './dto.js';
import type {
  ProductDetailDto,
  ProductDto,
  ProductPageDto,
} from './responses.js';

type Tx = Prisma.TransactionClient;

const productInclude = {
  category: { select: { id: true, name: true } },
  stockUnit: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ProductInclude;

type ProductWithRefs = Prisma.ProductGetPayload<{
  include: typeof productInclude;
}>;

const toNumber = (value: Prisma.Decimal | null) =>
  value === null ? null : value.toNumber();

// A plain object type (not the DTO class), so spreading it is fine.
type ProductFields = Pick<ProductDto, keyof ProductDto>;

function toDto(product: ProductWithRefs): ProductFields {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    stockUnit: product.stockUnit,
    lengthCm: toNumber(product.lengthCm),
    widthCm: toNumber(product.widthCm),
    heightCm: toNumber(product.heightCm),
    weightKg: toNumber(product.weightKg),
    volumeL: toNumber(product.volumeL),
    tracksLots: product.tracksLots,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** Ids of `rootId` and every category below it. */
export function categorySubtree(
  categories: { id: number; parentId: number | null }[],
  rootId: number,
): number[] {
  const children = new Map<number, number[]>();
  for (const { id, parentId } of categories) {
    if (parentId === null) continue;
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }
  const result: number[] = [];
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

// CU-03: the organization's product catalog. Products are never deleted; they
// are deactivated. The code (sku) is fixed once the product has movements.
@Injectable()
export class ProductsService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async list(
    auth: AuthContext,
    query: ListProductsQueryDto,
  ): Promise<ProductPageDto> {
    const tenant = this.tenant(auth);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const status = query.status ?? CatalogStatusFilter.ACTIVE;

    const where: Prisma.ProductWhereInput = {};
    if (status === CatalogStatusFilter.ACTIVE) where.isActive = true;
    if (status === CatalogStatusFilter.INACTIVE) where.isActive = false;
    if (query.search) {
      where.OR = [
        { sku: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.categoryId !== undefined) {
      const categories = await tenant.category.findMany({
        select: { id: true, parentId: true },
      });
      where.categoryId = {
        in: categorySubtree(categories, query.categoryId),
      };
    }

    const [total, products] = await Promise.all([
      tenant.product.count({ where }),
      tenant.product.findMany({
        where,
        include: productInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: products.map(toDto), total, page, pageSize };
  }

  async get(auth: AuthContext, id: number): Promise<ProductDetailDto> {
    const tenant = this.tenant(auth);
    const product = await tenant.product.findUnique({
      where: { id },
      include: {
        ...productInclude,
        warehouses: {
          orderBy: { warehouseId: 'asc' },
          include: {
            warehouse: { select: { id: true, name: true } },
            stockBalances: { select: { quantity: true } },
          },
        },
      },
    });
    if (!product) throw catalogErrors.productNotFound();

    const warehouses = product.warehouses.map((pw) => ({
      warehouse: pw.warehouse,
      onHand: pw.stockBalances
        .reduce((sum, b) => sum.add(b.quantity), new Prisma.Decimal(0))
        .toNumber(),
      safetyStock: pw.safetyStock.toNumber(),
      reorderPoint: pw.reorderPoint.toNumber(),
      valueSource: pw.valueSource,
    }));
    return {
      ...toDto(product),
      totalOnHand: warehouses.reduce((sum, w) => sum + w.onHand, 0),
      warehouses,
      hasMovements: await this.hasMovements(tenant, id),
    };
  }

  async create(auth: AuthContext, dto: CreateProductDto): Promise<ProductDto> {
    const tenant = this.tenant(auth);
    await this.assertCategoryUsable(tenant, dto.categoryId);
    await this.assertStockUnitExists(tenant, dto.stockUnitId);
    await this.assertSkuFree(tenant, dto.sku);

    try {
      const product = await tenant.product.create({
        data: {
          sku: dto.sku,
          name: dto.name,
          description: dto.description || null,
          categoryId: dto.categoryId,
          stockUnitId: dto.stockUnitId,
          lengthCm: dto.lengthCm ?? null,
          widthCm: dto.widthCm ?? null,
          heightCm: dto.heightCm ?? null,
          weightKg: dto.weightKg ?? null,
          volumeL: dto.volumeL ?? null,
          tracksLots: dto.tracksLots ?? false,
        },
        include: productInclude,
      });
      return toDto(product);
    } catch (error) {
      if (isUniqueViolation(error)) throw catalogErrors.skuTaken();
      throw error;
    }
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateProductDto,
  ): Promise<ProductDto> {
    const tenant = this.tenant(auth);
    const product = await tenant.product.findUnique({ where: { id } });
    if (!product) throw catalogErrors.productNotFound();

    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (dto.sku !== undefined && dto.sku !== product.sku) {
      if (await this.hasMovements(tenant, id)) throw catalogErrors.skuLocked();
      await this.assertSkuFree(tenant, dto.sku, id);
      data.sku = dto.sku;
    }
    if (dto.tracksLots !== undefined && dto.tracksLots !== product.tracksLots) {
      const lots = await tenant.lot.count({ where: { productId: id } });
      if (lots > 0 || (await this.hasMovements(tenant, id))) {
        throw catalogErrors.tracksLotsLocked();
      }
      data.tracksLots = dto.tracksLots;
    }
    if (dto.categoryId !== undefined && dto.categoryId !== product.categoryId) {
      await this.assertCategoryUsable(tenant, dto.categoryId);
      data.categoryId = dto.categoryId;
    }
    if (dto.stockUnitId !== undefined) {
      await this.assertStockUnitExists(tenant, dto.stockUnitId);
      data.stockUnitId = dto.stockUnitId;
    }
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) {
      data.description = dto.description || null;
    }
    for (const field of [
      'lengthCm',
      'widthCm',
      'heightCm',
      'weightKg',
      'volumeL',
    ] as const) {
      if (dto[field] !== undefined) data[field] = dto[field];
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;

    try {
      const updated = await tenant.product.update({
        where: { id },
        data,
        include: productInclude,
      });
      return toDto(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw catalogErrors.skuTaken();
      throw error;
    }
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  private async hasMovements(tenant: Tx, productId: number) {
    const line = await tenant.movementLine.findFirst({
      where: { productId },
      select: { movementId: true },
    });
    return line !== null;
  }

  private async assertSkuFree(tenant: Tx, sku: string, exceptId?: number) {
    const existing = await tenant.product.findFirst({
      where: {
        sku: { equals: sku, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (existing) throw catalogErrors.skuTaken();
  }

  private async assertCategoryUsable(tenant: Tx, categoryId: number) {
    const category = await tenant.category.findUnique({
      where: { id: categoryId },
    });
    if (!category?.isActive) throw catalogErrors.categoryInvalid();
  }

  private async assertStockUnitExists(tenant: Tx, unitId: number) {
    const unit = await tenant.unitOfMeasure.findUnique({
      where: { id: unitId },
    });
    if (!unit) throw catalogErrors.stockUnitInvalid();
  }
}
