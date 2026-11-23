import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { authErrors } from '../auth/auth-errors.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  AlertManualStatus,
  AlertSort,
  type ListAlertsQueryDto,
  type SetAlertStatusDto,
  type SetReplenishmentDto,
} from './dto.js';
import {
  BACK_TO_PENDING,
  evaluateAlerts,
  IN_FORCE,
  stockLevels,
} from './evaluate-alerts.js';
import {
  type CalculationIssue,
  refreshReorderPoints,
} from './reorder-point.js';
import { replenishmentErrors } from './replenishment-errors.js';
import type { AlertDto, AlertPageDto, ReplenishmentDto } from './responses.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

const productRef = {
  select: {
    id: true,
    sku: true,
    name: true,
    isActive: true,
    stockUnit: { select: { code: true } },
  },
} as const;

const alertInclude = {
  productWarehouse: {
    select: {
      product: productRef,
      warehouse: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.AlertInclude;

type AlertWithRefs = Prisma.AlertGetPayload<{ include: typeof alertInclude }>;

/** `GET /alerts?sort=`; `id` breaks ties so pages never overlap. */
const alertOrder: Record<AlertSort, Prisma.AlertOrderByWithRelationInput[]> = {
  [AlertSort.CREATED]: [{ createdAt: 'desc' }, { id: 'desc' }],
  [AlertSort.UPDATED]: [{ updatedAt: 'desc' }, { id: 'desc' }],
  [AlertSort.SEVERITY]: [
    { severity: 'desc' },
    { updatedAt: 'desc' },
    { id: 'desc' },
  ],
};

/** Names of the users who attended alerts, by tenant user id. */
type Attendants = Map<number, string>;

function toAlertDto(alert: AlertWithRefs, attendants: Attendants): AlertDto {
  const { product, warehouse } = alert.productWarehouse;
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.stockUnit.code,
    },
    warehouse,
    availableQuantity: alert.availableQuantity.toNumber(),
    reorderPoint: alert.reorderPoint.toNumber(),
    reorderPointSource: alert.reorderPointSource,
    suggestedQuantity: alert.suggestedQuantity.toNumber(),
    message: alert.message,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    resolvedAt: alert.resolvedAt,
    resolution: alert.resolution,
    attendedAt: alert.attendedAt,
    attendedBy:
      alert.attendedById === null
        ? null
        : {
            id: alert.attendedById,
            name: attendants.get(alert.attendedById) ?? '',
          },
  };
}

/** `safetyStock ≤ reorderPoint`, `minStock ≤ maxStock` and `reorderPoint ≤ maxStock`. */
export function replenishmentProblem(dto: SetReplenishmentDto): string | null {
  const { safetyStock, reorderPoint, minStock, maxStock } = dto;
  if (safetyStock > reorderPoint && reorderPoint > 0) {
    return 'The safety stock cannot exceed the reorder point';
  }
  if (minStock != null && maxStock != null && minStock > maxStock) {
    return 'The min stock cannot exceed the max stock';
  }
  if (maxStock != null && reorderPoint > maxStock) {
    return 'The reorder point cannot exceed the max stock';
  }
  return null;
}

// US-16 (manual safety stock and reorder point per warehouse) and CU-12 (stock
// alerts). Alerts are raised and resolved by `evaluateAlerts` after every movement
// and every change of the parameters (CU-12a).
@Injectable()
export class ReplenishmentService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly control: ControlPrismaService,
  ) {}

  async get(
    auth: AuthContext,
    productId: number,
    warehouseId: number,
  ): Promise<ReplenishmentDto> {
    if (
      !permissionsInWarehouse(auth.user.roles, warehouseId).has('stock.read')
    ) {
      throw authErrors.forbidden();
    }
    return this.load(this.tenant(auth), productId, warehouseId);
  }

  async set(
    auth: AuthContext,
    productId: number,
    warehouseId: number,
    dto: SetReplenishmentDto,
  ): Promise<ReplenishmentDto> {
    const permissions = permissionsInWarehouse(auth.user.roles, warehouseId);
    if (!permissions.has('replenishment.manage')) throw authErrors.forbidden();
    const problem = replenishmentProblem(dto);
    if (problem) throw replenishmentErrors.parametersInvalid(problem);

    const tenant = this.tenant(auth);
    await this.assertUsable(tenant, productId, warehouseId);
    const schema = assertTenantSchema(auth.organization.schemaName);
    // The manual values; which ones are in force follows from the method.
    const values = {
      manualSafetyStock: new Decimal(dto.safetyStock),
      manualReorderPoint: new Decimal(dto.reorderPoint),
      minStock: dto.minStock == null ? null : new Decimal(dto.minStock),
      maxStock: dto.maxStock == null ? null : new Decimal(dto.maxStock),
      ...(dto.replenishmentMethod && {
        replenishmentMethod: dto.replenishmentMethod,
      }),
      ...(dto.leadTimeDays !== undefined && {
        leadTimeDays: dto.leadTimeDays,
      }),
    };

    await tenant.$transaction(
      async (tx) => {
        // Same lock as movements, so the alert evaluation never races with one.
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "${schema}"."products" WHERE "id" = $1 FOR UPDATE`,
          productId,
        );
        const pw = await tx.productWarehouse.upsert({
          where: { productId_warehouseId: { productId, warehouseId } },
          create: { productId, warehouseId, ...values },
          update: values,
          select: { id: true },
        });
        await refreshReorderPoints(tx, [pw.id]);
        await evaluateAlerts(tx, [pw.id]);
        // The product lock may be held by a movement or a forecast run.
      },
      { timeout: 20_000 },
    );
    return this.load(tenant, productId, warehouseId);
  }

  async listAlerts(
    auth: AuthContext,
    query: ListAlertsQueryDto,
  ): Promise<AlertPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const empty = { items: [], total: 0, page, pageSize };

    const visible = warehousesWithPermission(auth.user.roles, 'alert.read');
    let warehouseIds = visible === 'ALL' ? null : visible;
    if (query.warehouseId !== undefined) {
      if (warehouseIds && !warehouseIds.includes(query.warehouseId)) {
        return empty;
      }
      warehouseIds = [query.warehouseId];
    }
    if (warehouseIds?.length === 0) return empty;

    const where: Prisma.AlertWhereInput = {
      productWarehouse: {
        ...(warehouseIds && { warehouseId: { in: warehouseIds } }),
        ...(query.productId !== undefined && { productId: query.productId }),
      },
      ...(query.status && { status: query.status }),
    };
    const tenant = this.tenant(auth);
    const [total, alerts] = await Promise.all([
      tenant.alert.count({ where }),
      tenant.alert.findMany({
        where,
        include: alertInclude,
        orderBy: alertOrder[query.sort ?? AlertSort.CREATED],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const attendants = await this.attendants(auth, alerts);
    return {
      items: alerts.map((alert) => toAlertDto(alert, attendants)),
      total,
      page,
      pageSize,
    };
  }

  async getAlert(auth: AuthContext, id: number): Promise<AlertDto> {
    const alert = await this.tenant(auth).alert.findUnique({
      where: { id },
      include: alertInclude,
    });
    if (
      !alert ||
      !permissionsInWarehouse(
        auth.user.roles,
        alert.productWarehouse.warehouse.id,
      ).has('alert.read')
    ) {
      throw replenishmentErrors.alertNotFound();
    }
    return toAlertDto(alert, await this.attendants(auth, [alert]));
  }

  /**
   * US-045: marks an alert in force as attended (someone took charge) or as
   * pending again. Needs `alert.resolve` in the alert's warehouse; a resolved
   * alert cannot change. Setting the status it already has changes nothing, so
   * who attended it first is kept.
   */
  async setAlertStatus(
    auth: AuthContext,
    id: number,
    dto: SetAlertStatusDto,
  ): Promise<AlertDto> {
    const tenant = this.tenant(auth);
    const alert = await tenant.alert.findUnique({
      where: { id },
      select: {
        status: true,
        productWarehouse: { select: { productId: true, warehouseId: true } },
      },
    });
    const permissions = alert
      ? permissionsInWarehouse(
          auth.user.roles,
          alert.productWarehouse.warehouseId,
        )
      : null;
    if (!alert || !permissions?.has('alert.read')) {
      throw replenishmentErrors.alertNotFound();
    }
    if (!permissions.has('alert.resolve')) throw authErrors.forbidden();
    if (!IN_FORCE.includes(alert.status)) {
      throw replenishmentErrors.alertClosed();
    }

    if (alert.status !== dto.status) {
      const schema = assertTenantSchema(auth.organization.schemaName);
      const now = new Date();
      await tenant.$transaction(async (tx) => {
        // Same lock as movements: an evaluation of this product never runs
        // between the check and the change.
        await tx.$queryRawUnsafe(
          `SELECT "id" FROM "${schema}"."products" WHERE "id" = $1 FOR UPDATE`,
          alert.productWarehouse.productId,
        );
        const { count } = await tx.alert.updateMany({
          where: { id, status: { in: IN_FORCE } },
          data:
            dto.status === AlertManualStatus.ATTENDED
              ? {
                  status: 'ATTENDED',
                  attendedAt: now,
                  attendedById: auth.user.id,
                  updatedAt: now,
                }
              : { ...BACK_TO_PENDING, updatedAt: now },
        });
        if (count === 0) throw replenishmentErrors.alertClosed();
      });
    }
    return this.getAlert(auth, id);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** The account names of whoever attended these alerts (control schema). */
  private async attendants(
    auth: AuthContext,
    alerts: { attendedById: number | null }[],
  ): Promise<Attendants> {
    const ids = [
      ...new Set(
        alerts.flatMap((a) =>
          a.attendedById === null ? [] : [a.attendedById],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.tenant(auth).user.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true },
    });
    const accounts = await this.control.account.findMany({
      where: { id: { in: users.map((u) => u.accountId) } },
      select: { id: true, name: true },
    });
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    return new Map(users.map((u) => [u.id, names.get(u.accountId) ?? '']));
  }

  private async assertUsable(
    tenant: Tx,
    productId: number,
    warehouseId: number,
  ) {
    const [product, warehouse] = await Promise.all([
      tenant.product.findUnique({
        where: { id: productId },
        select: { isActive: true },
      }),
      tenant.warehouse.findUnique({
        where: { id: warehouseId },
        select: { isActive: true },
      }),
    ]);
    if (!product?.isActive) throw replenishmentErrors.productNotFound();
    if (!warehouse?.isActive) throw replenishmentErrors.warehouseNotFound();
  }

  /** Current parameters and stock of a product in a warehouse (defaults if not enabled there). */
  private async load(
    tenant: Tx,
    productId: number,
    warehouseId: number,
  ): Promise<ReplenishmentDto> {
    const [product, warehouse, pw] = await Promise.all([
      tenant.product.findUnique({ where: { id: productId }, ...productRef }),
      tenant.warehouse.findUnique({
        where: { id: warehouseId },
        select: { id: true, name: true },
      }),
      tenant.productWarehouse.findUnique({
        where: { productId_warehouseId: { productId, warehouseId } },
        include: {
          alerts: {
            where: { type: 'BELOW_ROP', status: { in: IN_FORCE } },
            select: {
              id: true,
              status: true,
              severity: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      }),
    ]);
    if (!product) throw replenishmentErrors.productNotFound();
    if (!warehouse) throw replenishmentErrors.warehouseNotFound();

    const level = pw
      ? (await stockLevels(tenant, [pw])).get(pw.id)!
      : undefined;
    const inForce = pw?.alerts[0];
    return {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.stockUnit.code,
      },
      warehouse,
      onHand: level?.onHand.toNumber() ?? 0,
      reserved: level?.reserved.toNumber() ?? 0,
      available: level?.available.toNumber() ?? 0,
      replenishmentMethod: pw?.replenishmentMethod ?? 'FIXED_ROP',
      leadTimeDays: pw?.leadTimeDays ?? 7,
      safetyStock: pw?.safetyStock.toNumber() ?? 0,
      reorderPoint: pw?.reorderPoint.toNumber() ?? 0,
      manualSafetyStock: pw?.manualSafetyStock.toNumber() ?? 0,
      manualReorderPoint: pw?.manualReorderPoint.toNumber() ?? 0,
      minStock: pw?.minStock?.toNumber() ?? null,
      maxStock: pw?.maxStock?.toNumber() ?? null,
      valueSource: pw?.valueSource ?? 'MANUAL',
      baseForecastId: pw?.baseForecastId ?? null,
      calculatedAt: pw?.calculatedAt ?? null,
      calculationIssue:
        (pw?.calculationIssue as CalculationIssue | null | undefined) ?? null,
      openAlert: inForce
        ? {
            ...inForce,
            status: inForce.status === 'ATTENDED' ? 'ATTENDED' : 'OPEN',
          }
        : null,
    };
  }
}
