import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
} from '../auth/auth-context.js';
import { categorySubtree } from '../catalog/products.service.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  type StockLevel,
  stockLevels,
} from '../replenishment/evaluate-alerts.js';
import type { ListStockQueryDto, UpdateLotDto } from './dto.js';
import type {
  BalanceDto,
  LotDto,
  LotStockDto,
  ProductStockDto,
  StockLevelDto,
  StockPageDto,
} from './responses.js';
import { stockErrors } from './stock-errors.js';

type Tx = Prisma.TransactionClient;

const productSelect = {
  id: true,
  sku: true,
  name: true,
  tracksLots: true,
  isActive: true,
  category: { select: { id: true, name: true } },
  stockUnit: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ProductSelect;

const lotSelect = {
  id: true,
  code: true,
  manufactureDate: true,
  expiryDate: true,
} satisfies Prisma.LotSelect;

type LotRow = Prisma.LotGetPayload<{ select: typeof lotSelect }>;

const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

// Plain object types (not the DTO classes), so spreading them is fine.
type LotFields = Pick<LotDto, keyof LotDto>;
type LevelFields = Pick<StockLevelDto, keyof StockLevelDto>;

function toLotDto(lot: LotRow): LotFields {
  return {
    id: lot.id,
    code: lot.code,
    manufactureDate: day(lot.manufactureDate),
    expiryDate: day(lot.expiryDate),
  };
}

function toLevelDto(level: StockLevel | undefined): LevelFields {
  return {
    onHand: level?.onHand.toNumber() ?? 0,
    reserved: level?.reserved.toNumber() ?? 0,
    available: level?.available.toNumber() ?? 0,
  };
}

/** Earliest expiry first (lots without one last), then by code. */
export function byExpiry(a: LotRow, b: LotRow): number {
  const ae = a.expiryDate?.getTime() ?? Infinity;
  const be = b.expiryDate?.getTime() ?? Infinity;
  return ae - be || a.code.localeCompare(b.code);
}

/** Escapes `%`, `_` and `\` for a LIKE pattern. */
export const likePattern = (text: string) =>
  `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Stock queries per warehouse (the inventory page "by warehouse"), stock of a
// product by location and lot, and its lots. All of them need `stock.read` in
// the warehouse; without it the warehouse answers 404, as `GET /warehouses/:id`.
@Injectable()
export class StockService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async list(
    auth: AuthContext,
    query: ListStockQueryDto,
  ): Promise<StockPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const tenant = this.tenant(auth);
    await this.assertReadable(tenant, auth, query.warehouseId);
    const schema = assertTenantSchema(auth.organization.schemaName);

    let categoryIds: number[] | null = null;
    if (query.categoryId !== undefined) {
      const categories = await tenant.category.findMany({
        select: { id: true, parentId: true },
      });
      categoryIds = categorySubtree(categories, query.categoryId);
    }

    // Product-warehouses of the warehouse with stock ≠ 0 (archived products too),
    // or, with includeZero, also the active ones with no stock.
    const filtered = `
      SELECT pw."id", pw."product_id" AS "productId", p."name", p."id" AS "pid"
        FROM "${schema}"."product_warehouses" pw
        JOIN "${schema}"."products" p ON p."id" = pw."product_id"
        LEFT JOIN "${schema}"."stock_balances" sb ON sb."product_warehouse_id" = pw."id"
       WHERE pw."warehouse_id" = $1
         AND ($2::text IS NULL OR p."sku" ILIKE $2 OR p."name" ILIKE $2)
         AND ($3::int[] IS NULL OR p."category_id" = ANY($3::int[]))
       GROUP BY pw."id", p."id"
      HAVING COALESCE(SUM(sb."quantity"), 0) <> 0
          OR ($4::boolean AND pw."is_active" AND p."is_active")`;
    const params = [
      query.warehouseId,
      query.search ? likePattern(query.search) : null,
      categoryIds,
      query.includeZero ?? false,
    ];
    const [{ total }] = await tenant.$queryRawUnsafe<{ total: number }[]>(
      `SELECT COUNT(*)::int AS "total" FROM (${filtered}) f`,
      ...params,
    );
    const rows =
      total === 0
        ? []
        : await tenant.$queryRawUnsafe<{ id: number; productId: number }[]>(
            `SELECT "id", "productId" FROM (${filtered}) f
              ORDER BY "name", "pid" LIMIT $5 OFFSET $6`,
            ...params,
            pageSize,
            (page - 1) * pageSize,
          );
    if (rows.length === 0) return { items: [], total, page, pageSize };

    const pws = rows.map((row) => ({ ...row, warehouseId: query.warehouseId }));
    const products = await tenant.product.findMany({
      where: { id: { in: rows.map((r) => r.productId) } },
      select: productSelect,
    });
    const levels = await stockLevels(tenant, pws);
    const productById = new Map(products.map((p) => [p.id, p]));
    return {
      items: rows.map((row) => ({
        product: productById.get(row.productId)!,
        ...toLevelDto(levels.get(row.id)),
      })),
      total,
      page,
      pageSize,
    };
  }

  async productStock(
    auth: AuthContext,
    productId: number,
    warehouseId: number,
  ): Promise<ProductStockDto> {
    const tenant = this.tenant(auth);
    const warehouse = await this.assertReadable(tenant, auth, warehouseId);
    const product = await this.product(tenant, productId);
    const pw = await tenant.productWarehouse.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
      select: { id: true, productId: true, warehouseId: true },
    });
    const level = pw ? (await stockLevels(tenant, [pw])).get(pw.id) : undefined;
    const balances = pw
      ? await tenant.stockBalance.findMany({
          where: { productWarehouseId: pw.id, quantity: { not: 0 } },
          select: {
            quantity: true,
            location: { select: { id: true, code: true } },
            lot: { select: lotSelect },
          },
        })
      : [];
    const ordered: BalanceDto[] = balances
      .sort(
        (a, b) =>
          a.location.code.localeCompare(b.location.code) ||
          (a.lot && b.lot ? byExpiry(a.lot, b.lot) : 0),
      )
      .map((balance) => ({
        location: balance.location,
        lot: balance.lot && toLotDto(balance.lot),
        onHand: balance.quantity.toNumber(),
      }));
    return {
      product,
      warehouse,
      ...toLevelDto(level),
      balances: ordered,
    };
  }

  /** Lots with stock in the warehouse, earliest expiry first. */
  async lots(
    auth: AuthContext,
    productId: number,
    warehouseId: number,
  ): Promise<LotStockDto[]> {
    const tenant = this.tenant(auth);
    await this.assertReadable(tenant, auth, warehouseId);
    await this.product(tenant, productId);
    const balances = await tenant.stockBalance.findMany({
      where: {
        productWarehouse: { productId, warehouseId },
        lotId: { not: null },
        quantity: { not: 0 },
      },
      select: {
        quantity: true,
        location: { select: { id: true, code: true } },
        lot: { select: lotSelect },
      },
      orderBy: { location: { code: 'asc' } },
    });

    const byLot = new Map<number, { lot: LotRow; balances: typeof balances }>();
    for (const balance of balances) {
      const lot = balance.lot!;
      const entry = byLot.get(lot.id) ?? { lot, balances: [] };
      entry.balances.push(balance);
      byLot.set(lot.id, entry);
    }
    return [...byLot.values()]
      .sort((a, b) => byExpiry(a.lot, b.lot))
      .map(({ lot, balances: lotBalances }) => ({
        ...toLotDto(lot),
        onHand: lotBalances
          .reduce((sum, b) => sum.add(b.quantity), new Prisma.Decimal(0))
          .toNumber(),
        locations: lotBalances.map((b) => ({
          location: b.location,
          onHand: b.quantity.toNumber(),
        })),
      }));
  }

  async updateLot(
    auth: AuthContext,
    productId: number,
    lotId: number,
    dto: UpdateLotDto,
  ): Promise<LotDto> {
    const tenant = this.tenant(auth);
    const lot = await tenant.lot.findFirst({
      where: { id: lotId, productId },
      select: lotSelect,
    });
    if (!lot) throw stockErrors.lotNotFound();

    const date = (value: string | null | undefined, current: Date | null) =>
      value === undefined ? current : value === null ? null : new Date(value);
    const manufactureDate = date(dto.manufactureDate, lot.manufactureDate);
    const expiryDate = date(dto.expiryDate, lot.expiryDate);
    if (manufactureDate && expiryDate && expiryDate < manufactureDate) {
      throw stockErrors.lotDatesInvalid();
    }
    const updated = await tenant.lot.update({
      where: { id: lotId },
      data: { manufactureDate, expiryDate },
      select: lotSelect,
    });
    return toLotDto(updated);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** The warehouse, if it exists and the user holds `stock.read` there; else 404. */
  private async assertReadable(
    tenant: Tx,
    auth: AuthContext,
    warehouseId: number,
  ) {
    if (
      !permissionsInWarehouse(auth.user.roles, warehouseId).has('stock.read')
    ) {
      throw stockErrors.warehouseNotFound();
    }
    const warehouse = await tenant.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, name: true },
    });
    if (!warehouse) throw stockErrors.warehouseNotFound();
    return warehouse;
  }

  private async product(tenant: Tx, id: number) {
    const product = await tenant.product.findUnique({
      where: { id },
      select: productSelect,
    });
    if (!product) throw stockErrors.productNotFound();
    return product;
  }
}
