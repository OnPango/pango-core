import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  daysOfCover,
  forecastDailyDemand,
  loadSettings,
  loadStockPositions,
  type NetMovement,
  netMovementsSince,
  round,
  type StockPosition,
  stockValue,
  type Tenant,
} from './dashboard-data.js';
import {
  inFilter,
  readableWarehouses,
  type WarehouseFilter,
} from './dashboard-scope.js';
import type { DashboardQueryDto } from './dto.js';
import type {
  ActivityItemDto,
  DashboardSummaryDto,
  LowStockTrendDto,
  ReplenishBlockDto,
  RequestTrendDto,
  TrendDto,
} from './responses.js';

/** Items of the "low stock" list and of the recent activity. */
export const SUMMARY_LIST_SIZE = 8;

/**
 * SQL: the movement aliased `m` has a line leaving or entering a warehouse of the
 * filter bound to `$param`.
 */
export const movementTouches = (schema: string, param: number) =>
  `($${param}::int[] IS NULL OR EXISTS (
     SELECT 1 FROM "${schema}"."movement_lines" ml
       LEFT JOIN "${schema}"."locations" lo ON lo."id" = ml."origin_location_id"
       LEFT JOIN "${schema}"."locations" ld ON ld."id" = ml."destination_location_id"
      WHERE ml."movement_id" = m."id"
        AND (lo."warehouse_id" = ANY($${param}::int[])
          OR ld."warehouse_id" = ANY($${param}::int[]))))`;

/** The same moment one calendar month earlier: what every trend compares with. */
export function oneMonthBefore(now: Date): Date {
  const date = new Date(now);
  date.setMonth(date.getMonth() - 1);
  return date;
}

/**
 * Stock value one month ago: today's on hand minus what entered and plus what left
 * since then, at today's average cost (past costs are not kept).
 */
export function valueBefore(
  positions: StockPosition[],
  net: NetMovement[],
): number {
  const since = new Map<string, number>();
  for (const row of net) {
    const key = `${row.productId}:${row.warehouseId}`;
    since.set(key, (since.get(key) ?? 0) + row.net);
  }
  return round(
    positions.reduce((sum, p) => {
      const before =
        p.onHand - (since.get(`${p.productId}:${p.warehouseId}`) ?? 0);
      return sum + Math.max(before, 0) * p.averageCost;
    }, 0),
    2,
  );
}

// US-047: the top of the dashboard. Each figure follows the read permission of its
// module, in the user's warehouses; one the user cannot read is null. Every
// figure comes with its value one month earlier.
@Injectable()
export class DashboardSummaryService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly control: ControlPrismaService,
  ) {}

  async summary(
    auth: AuthContext,
    query: DashboardQueryDto,
  ): Promise<DashboardSummaryDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const { currency } = await loadSettings(tenant);
    const now = new Date();
    const before = oneMonthBefore(now);
    const scope = (permission: string) =>
      readableWarehouses(auth, permission, query.warehouseId);
    const catalog = scope('catalog.read');
    const stock = scope('stock.read');
    const alerts = scope('alert.read');
    const requests = scope('stock_request.read');
    const movements = scope('movement.read');

    const [products, stockValueTrend, lowStock, pendingRequests] =
      await Promise.all([
        catalog === false
          ? null
          : this.productCount(tenant, schema, catalog, before),
        stock === false ? null : this.stockValue(tenant, schema, stock, before),
        alerts === false ? null : this.lowStock(tenant, schema, alerts, before),
        requests === false
          ? null
          : this.pendingRequests(tenant, schema, requests, before),
      ]);
    const [lowStockItems, recentActivity] = await Promise.all([
      alerts === false ? null : this.lowStockItems(tenant, schema, alerts),
      movements === false
        ? null
        : this.recentActivity(tenant, schema, movements),
    ]);

    return {
      currency,
      comparedTo: before,
      kpis: {
        products,
        stockValue: stockValueTrend,
        lowStock,
        pendingRequests,
      },
      lowStockItems,
      recentActivity,
    };
  }

  /**
   * Active products; with a warehouse, those active there. One month ago: the
   * ones that already existed (archiving is not dated, so it is not undone).
   */
  private async productCount(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
    before: Date,
  ): Promise<TrendDto> {
    const [row] = await tenant.$queryRawUnsafe<TrendDto[]>(
      warehouses === null
        ? `SELECT COUNT(*)::int AS "current",
                  COUNT(*) FILTER (WHERE "created_at" <= $1)::int AS "previous"
             FROM "${schema}"."products" WHERE "is_active"`
        : `SELECT COUNT(DISTINCT p."id")::int AS "current",
                  COUNT(DISTINCT p."id") FILTER (WHERE pw."created_at" <= $1)::int AS "previous"
             FROM "${schema}"."product_warehouses" pw
             JOIN "${schema}"."products" p ON p."id" = pw."product_id"
            WHERE p."is_active" AND pw."is_active" AND ${inFilter('pw."warehouse_id"', 2)}`,
      before,
      ...(warehouses === null ? [] : [warehouses]),
    );
    return row;
  }

  private async stockValue(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
    before: Date,
  ): Promise<TrendDto> {
    const [positions, net] = await Promise.all([
      loadStockPositions(tenant, schema, warehouses),
      netMovementsSince(tenant, schema, warehouses, before, 'UTC'),
    ]);
    return {
      current: round(
        positions.reduce((sum, p) => sum + stockValue(p), 0),
        2,
      ),
      previous: valueBefore(positions, net),
    };
  }

  /**
   * Products with an alert in force (pending or attended) in any of the
   * warehouses, now and one month ago; each product counts once.
   */
  private async lowStock(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
    before: Date,
  ): Promise<LowStockTrendDto> {
    const [row] = await tenant.$queryRawUnsafe<LowStockTrendDto[]>(
      `SELECT COUNT(DISTINCT pw."product_id") FILTER (
                WHERE a."status" IN ('OPEN', 'ATTENDED'))::int AS "current",
              COUNT(DISTINCT pw."product_id") FILTER (
                WHERE a."status" IN ('OPEN', 'ATTENDED') AND a."severity" = 3)::int AS "critical",
              COUNT(DISTINCT pw."product_id") FILTER (
                WHERE a."created_at" <= $2
                  AND (a."resolved_at" IS NULL OR a."resolved_at" > $2))::int AS "previous"
         FROM "${schema}"."alerts" a
         JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
        WHERE ${inFilter('pw."warehouse_id"', 1)}`,
      warehouses,
      before,
    );
    return row;
  }

  /**
   * Stock requests waiting (pending or being attended) now and one month ago: a
   * request was waiting then if it existed and had not been fulfilled, rejected or
   * cancelled yet (its events say when).
   */
  private async pendingRequests(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
    before: Date,
  ): Promise<RequestTrendDto> {
    const [row] = await tenant.$queryRawUnsafe<RequestTrendDto[]>(
      `WITH closed AS (
         SELECT "stock_request_id", MIN("created_at") AS "at"
           FROM "${schema}"."stock_request_events"
          WHERE "status" IN ('FULFILLED', 'REJECTED', 'CANCELLED')
          GROUP BY 1
       )
       SELECT COUNT(*) FILTER (WHERE r."status" IN ('PENDING', 'IN_PROGRESS'))::int AS "current",
              COUNT(*) FILTER (WHERE r."status" = 'PENDING')::int AS "pending",
              COUNT(*) FILTER (WHERE r."status" = 'IN_PROGRESS')::int AS "inProgress",
              COUNT(*) FILTER (
                WHERE r."created_at" <= $2 AND (c."at" IS NULL OR c."at" > $2))::int AS "previous"
         FROM "${schema}"."stock_requests" r
         LEFT JOIN closed c ON c."stock_request_id" = r."id"
        WHERE ${inFilter('r."warehouse_id"', 1)}`,
      warehouses,
      before,
    );
    return row;
  }

  /** Alerts in force, most severe first, with how long the stock lasts. */
  private async lowStockItems(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
  ): Promise<ReplenishBlockDto> {
    const where = `a."status" IN ('OPEN', 'ATTENDED') AND ${inFilter('pw."warehouse_id"', 1)}`;
    const [[{ total }], rows] = await Promise.all([
      tenant.$queryRawUnsafe<{ total: number }[]>(
        `SELECT COUNT(*)::int AS "total"
           FROM "${schema}"."alerts" a
           JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
          WHERE ${where}`,
        warehouses,
      ),
      tenant.$queryRawUnsafe<
        {
          alertId: number;
          severity: number;
          status: 'OPEN' | 'ATTENDED';
          productWarehouseId: number;
          productId: number;
          sku: string;
          name: string;
          unit: string;
          warehouseId: number;
          warehouseName: string;
          available: number;
          reorderPoint: number;
          suggested: number;
        }[]
      >(
        `SELECT a."id" AS "alertId", a."severity", a."status",
                pw."id" AS "productWarehouseId", p."id" AS "productId", p."sku", p."name",
                u."code" AS "unit", w."id" AS "warehouseId", w."name" AS "warehouseName",
                a."available_quantity"::float8 AS "available",
                a."reorder_point"::float8 AS "reorderPoint",
                a."suggested_quantity"::float8 AS "suggested"
           FROM "${schema}"."alerts" a
           JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
           JOIN "${schema}"."products" p ON p."id" = pw."product_id"
           JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
           JOIN "${schema}"."warehouses" w ON w."id" = pw."warehouse_id"
          WHERE ${where}
          ORDER BY a."severity" DESC, a."updated_at" DESC, a."id" DESC
          LIMIT ${SUMMARY_LIST_SIZE}`,
        warehouses,
      ),
    ]);
    const daily = await forecastDailyDemand(
      tenant,
      schema,
      rows.map((r) => r.productWarehouseId),
    );
    return {
      total,
      items: rows.map((r) => ({
        alertId: r.alertId,
        severity: r.severity,
        status: r.status,
        product: { id: r.productId, sku: r.sku, name: r.name, unit: r.unit },
        warehouse: { id: r.warehouseId, name: r.warehouseName },
        available: r.available,
        reorderPoint: r.reorderPoint,
        suggested: r.suggested,
        daysOfCover: daysOfCover(r.available, daily.get(r.productWarehouseId)),
      })),
    };
  }

  /** The latest registered movements (drafts left out), newest first. */
  private async recentActivity(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
  ): Promise<ActivityItemDto[]> {
    const rows = await tenant.$queryRawUnsafe<
      {
        id: number;
        number: string;
        status: string;
        type: string;
        nature: string;
        occurredAt: Date;
        registeredById: number;
        firstProduct: string;
        firstSku: string;
        originId: number | null;
        originName: string | null;
        destinationId: number | null;
        destinationName: string | null;
        lineCount: number;
      }[]
    >(
      `SELECT m."id", m."number", m."status"::text AS "status", t."name" AS "type",
              t."nature"::text AS "nature", m."occurred_at" AS "occurredAt",
              m."registered_by_id" AS "registeredById",
              fl."product" AS "firstProduct", fl."sku" AS "firstSku",
              fl."originId", fl."originName", fl."destinationId", fl."destinationName",
              (SELECT COUNT(*)::int FROM "${schema}"."movement_lines" c
                WHERE c."movement_id" = m."id") AS "lineCount"
         FROM "${schema}"."movements" m
         JOIN "${schema}"."movement_types" t ON t."id" = m."movement_type_id"
         JOIN LATERAL (
           SELECT p."name" AS "product", p."sku",
                  wo."id" AS "originId", wo."name" AS "originName",
                  wd."id" AS "destinationId", wd."name" AS "destinationName"
             FROM "${schema}"."movement_lines" l
             JOIN "${schema}"."products" p ON p."id" = l."product_id"
             LEFT JOIN "${schema}"."locations" lo ON lo."id" = l."origin_location_id"
             LEFT JOIN "${schema}"."warehouses" wo ON wo."id" = lo."warehouse_id"
             LEFT JOIN "${schema}"."locations" ld ON ld."id" = l."destination_location_id"
             LEFT JOIN "${schema}"."warehouses" wd ON wd."id" = ld."warehouse_id"
            WHERE l."movement_id" = m."id"
            ORDER BY l."line_number"
            LIMIT 1
         ) fl ON true
        WHERE m."status" <> 'DRAFT' AND ${movementTouches(schema, 1)}
        ORDER BY m."occurred_at" DESC, m."id" DESC
        LIMIT ${SUMMARY_LIST_SIZE}`,
      warehouses,
    );
    const names = await this.userNames(
      tenant,
      rows.map((r) => r.registeredById),
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      type: r.type,
      nature: r.nature,
      occurredAt: r.occurredAt,
      warehouse:
        r.originId !== null
          ? { id: r.originId, name: r.originName! }
          : { id: r.destinationId!, name: r.destinationName! },
      destinationWarehouse:
        r.nature === 'TRANSFER' && r.destinationId !== null
          ? { id: r.destinationId, name: r.destinationName! }
          : null,
      firstProduct: r.firstProduct,
      firstSku: r.firstSku,
      lineCount: r.lineCount,
      registeredBy: names.get(r.registeredById) ?? '',
    }));
  }

  /** Account names of tenant users (they live in the control schema). */
  private async userNames(
    tenant: Tenant,
    userIds: number[],
  ): Promise<Map<number, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await tenant.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true },
    });
    const accounts = await this.control.account.findMany({
      where: { id: { in: users.map((u) => u.accountId) } },
      select: { id: true, name: true },
    });
    const byAccount = new Map(accounts.map((a) => [a.id, a.name]));
    return new Map(users.map((u) => [u.id, byAccount.get(u.accountId) ?? '']));
  }
}
