import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { authErrors } from '../auth/auth-errors.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import type { ListAlertsQueryDto, SetReplenishmentDto } from './dto.js';
import { evaluateAlerts, stockLevels } from './evaluate-alerts.js';
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

function toAlertDto(alert: AlertWithRefs): AlertDto {
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
    resolvedAt: alert.resolvedAt,
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
  constructor(private readonly tenants: TenantPrismaService) {}

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
    const values = {
      safetyStock: new Decimal(dto.safetyStock),
      reorderPoint: new Decimal(dto.reorderPoint),
      minStock: dto.minStock == null ? null : new Decimal(dto.minStock),
      maxStock: dto.maxStock == null ? null : new Decimal(dto.maxStock),
      valueSource: 'MANUAL' as const,
    };

    await tenant.$transaction(async (tx) => {
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
      await evaluateAlerts(tx, [pw.id]);
    });
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: alerts.map(toAlertDto), total, page, pageSize };
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
    return toAlertDto(alert);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
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
            where: { type: 'BELOW_ROP', status: 'OPEN' },
            select: { id: true, severity: true, createdAt: true },
          },
        },
      }),
    ]);
    if (!product) throw replenishmentErrors.productNotFound();
    if (!warehouse) throw replenishmentErrors.warehouseNotFound();

    const level = pw
      ? (await stockLevels(tenant, [pw])).get(pw.id)!
      : undefined;
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
      safetyStock: pw?.safetyStock.toNumber() ?? 0,
      reorderPoint: pw?.reorderPoint.toNumber() ?? 0,
      minStock: pw?.minStock?.toNumber() ?? null,
      maxStock: pw?.maxStock?.toNumber() ?? null,
      valueSource: pw?.valueSource ?? 'MANUAL',
      openAlert: pw?.alerts[0] ?? null,
    };
  }
}
