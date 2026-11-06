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
  AdjustmentDirection,
  type CreateMovementDto,
  type ListMovementsQueryDto,
  type ListMovementTypesQueryDto,
} from './dto.js';
import { movementErrors } from './movement-errors.js';
import type {
  MovementDto,
  MovementPageDto,
  MovementTypeDto,
} from './responses.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

/** Whether a line adds stock to its location or removes it. */
type Effect = 'IN' | 'OUT';

interface PlannedLine {
  lineNumber: number;
  product: { id: number; sku: string };
  effect: Effect;
  quantity: Decimal;
  /** Explicit location; otherwise resolved inside the transaction. */
  locationId?: number;
  lotCode?: string;
  unitCost?: Decimal;
}

const movementInclude = {
  movementType: {
    select: { id: true, name: true, nature: true, countsAsDemand: true },
  },
  department: { select: { id: true, name: true } },
  registeredBy: { select: { id: true, accountId: true } },
  lines: {
    orderBy: { lineNumber: 'asc' },
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          name: true,
          stockUnit: { select: { code: true } },
        },
      },
      originLocation: {
        select: {
          id: true,
          code: true,
          warehouse: { select: { id: true, name: true } },
        },
      },
      destinationLocation: {
        select: {
          id: true,
          code: true,
          warehouse: { select: { id: true, name: true } },
        },
      },
      lot: { select: { id: true, code: true } },
    },
  },
} satisfies Prisma.MovementInclude;

type MovementWithRefs = Prisma.MovementGetPayload<{
  include: typeof movementInclude;
}>;

/** Movement number shown to users, derived from its id. */
export const movementNumber = (id: number) =>
  `MV-${String(id).padStart(8, '0')}`;

/** Movements with a line at a location of one of these warehouses. */
function inWarehouses(ids: number[]): Prisma.MovementWhereInput {
  return {
    lines: {
      some: {
        OR: [
          { originLocation: { warehouseId: { in: ids } } },
          { destinationLocation: { warehouseId: { in: ids } } },
        ],
      },
    },
  };
}

/**
 * Movement types the user may register in a warehouse: one of their roles there
 * (or on every warehouse) grants `movement.create` and allows the type.
 */
function registrableBy(
  userId: number,
  warehouseId: number,
): Prisma.MovementTypeWhereInput {
  return {
    roles: {
      some: {
        role: {
          assignments: {
            some: {
              userId,
              OR: [{ warehouseId }, { warehouseId: null }],
            },
          },
          permissions: {
            some: { permission: { code: 'movement.create' } },
          },
        },
      },
    },
  };
}

/** Effect of a line by the type's nature (adjustments carry their own direction). */
export function lineEffect(
  nature: 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT',
  direction: AdjustmentDirection | undefined,
  lineNumber: number,
): Effect {
  if (nature === 'ADJUSTMENT') {
    if (!direction) throw movementErrors.directionRequired(lineNumber);
    return direction === AdjustmentDirection.INCREASE ? 'IN' : 'OUT';
  }
  if (direction) throw movementErrors.directionNotAllowed(lineNumber);
  return nature === 'INBOUND' ? 'IN' : 'OUT';
}

/** Weighted average cost after adding `quantity` at `unitCost`. */
export function weightedAverage(
  onHand: Decimal,
  averageCost: Decimal,
  quantity: Decimal,
  unitCost: Decimal,
): Decimal {
  // Negative on-hand (allowed by settings) carries no cost.
  const base = Decimal.max(onHand, 0);
  return base
    .mul(averageCost)
    .add(quantity.mul(unitCost))
    .div(base.add(quantity))
    .toDecimalPlaces(4);
}

// CU-05 (US-12, US-13, US-14): inbound, outbound and adjustment movements. A
// movement is registered already confirmed: its lines and the stock balances
// change in one transaction, and it is never edited or deleted (RN-006).
// Stock cannot go negative (RN-005) unless `settings.allow_negative_stock`.
@Injectable()
export class MovementsService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
  ) {}

  async listTypes(
    auth: AuthContext,
    query: ListMovementTypesQueryDto,
  ): Promise<MovementTypeDto[]> {
    const where =
      query.warehouseId === undefined
        ? {}
        : registrableBy(auth.user.id, query.warehouseId);
    return this.tenant(auth).movementType.findMany({
      where,
      select: {
        id: true,
        name: true,
        nature: true,
        countsAsDemand: true,
        isBase: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async list(
    auth: AuthContext,
    query: ListMovementsQueryDto,
  ): Promise<MovementPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const empty = { items: [], total: 0, page, pageSize };

    const visible = warehousesWithPermission(auth.user.roles, 'movement.read');
    let warehouseIds = visible === 'ALL' ? null : visible;
    if (query.warehouseId !== undefined) {
      if (warehouseIds && !warehouseIds.includes(query.warehouseId)) {
        return empty;
      }
      warehouseIds = [query.warehouseId];
    }
    if (warehouseIds?.length === 0) return empty;

    const and: Prisma.MovementWhereInput[] = [];
    if (warehouseIds) and.push(inWarehouses(warehouseIds));
    if (query.productId !== undefined) {
      and.push({ lines: { some: { productId: query.productId } } });
    }
    if (query.movementTypeId !== undefined) {
      and.push({ movementTypeId: query.movementTypeId });
    }
    if (query.nature) and.push({ movementType: { nature: query.nature } });
    if (query.from) and.push({ occurredAt: { gte: new Date(query.from) } });
    if (query.to) and.push({ occurredAt: { lte: new Date(query.to) } });
    const where: Prisma.MovementWhereInput = { AND: and };

    const tenant = this.tenant(auth);
    const [total, movements] = await Promise.all([
      tenant.movement.count({ where }),
      tenant.movement.findMany({
        where,
        include: movementInclude,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.toDtos(movements), total, page, pageSize };
  }

  async get(auth: AuthContext, id: number): Promise<MovementDto> {
    const movement = await this.tenant(auth).movement.findUnique({
      where: { id },
      include: movementInclude,
    });
    if (!movement) throw movementErrors.notFound();
    const [dto] = await this.toDtos([movement]);
    if (
      !permissionsInWarehouse(auth.user.roles, dto.warehouse.id).has(
        'movement.read',
      )
    ) {
      throw movementErrors.notFound();
    }
    return dto;
  }

  async create(
    auth: AuthContext,
    dto: CreateMovementDto,
  ): Promise<MovementDto> {
    const permissions = permissionsInWarehouse(
      auth.user.roles,
      dto.warehouseId,
    );
    if (!permissions.has('movement.create')) throw authErrors.forbidden();

    const tenant = this.tenant(auth);
    const [warehouse, type, settings] = await Promise.all([
      tenant.warehouse.findUnique({ where: { id: dto.warehouseId } }),
      tenant.movementType.findUnique({ where: { id: dto.movementTypeId } }),
      tenant.settings.findUnique({ where: { id: 1 } }),
    ]);
    if (!warehouse?.isActive) throw movementErrors.warehouseInvalid();
    if (!type) throw movementErrors.typeInvalid();
    const nature = type.nature;
    if (nature === 'TRANSFER') throw movementErrors.typeNotSupported();

    const allowed = await tenant.movementType.findFirst({
      where: { id: type.id, ...registrableBy(auth.user.id, warehouse.id) },
      select: { id: true },
    });
    if (!allowed) throw movementErrors.typeNotAllowed();

    if (dto.departmentId !== undefined) {
      const department = await tenant.department.findUnique({
        where: { id: dto.departmentId },
      });
      if (!department?.isActive) throw movementErrors.departmentInvalid();
    }

    const lines = await this.planLines(tenant, warehouse.id, nature, dto);
    const allowNegative = settings?.allowNegativeStock ?? false;
    const schema = assertTenantSchema(auth.organization.schemaName);

    const id = await tenant.$transaction(
      async (tx) => {
        const resolved = await this.applyLines(tx, schema, {
          warehouse: {
            id: warehouse.id,
            defaultLocationId: warehouse.defaultLocationId,
          },
          lines,
          allowNegative,
        });
        const [{ id }] = await tx.$queryRawUnsafe<{ id: number }[]>(
          `SELECT nextval(pg_get_serial_sequence('"${schema}"."movements"', 'id'))::int AS "id"`,
        );
        await tx.movement.create({
          data: {
            id,
            number: movementNumber(id),
            movementTypeId: type.id,
            registeredById: auth.user.id,
            departmentId: dto.departmentId ?? null,
            status: 'CONFIRMED',
            documentRef: dto.documentRef || null,
            notes: dto.notes || null,
            lines: {
              create: resolved.map((line) => ({
                lineNumber: line.lineNumber,
                productId: line.productId,
                originLocationId:
                  line.effect === 'OUT' ? line.locationId : null,
                destinationLocationId:
                  line.effect === 'IN' ? line.locationId : null,
                lotId: line.lotId,
                quantity: line.quantity,
                unitCost: line.unitCost,
              })),
            },
          },
        });
        return id;
      },
      { timeout: 20_000 },
    );

    const movement = await tenant.movement.findUniqueOrThrow({
      where: { id },
      include: movementInclude,
    });
    const [result] = await this.toDtos([movement]);
    return result;
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** Validates the lines against the catalog and the warehouse's locations. */
  private async planLines(
    tenant: Tx,
    warehouseId: number,
    nature: 'INBOUND' | 'OUTBOUND' | 'ADJUSTMENT',
    dto: CreateMovementDto,
  ): Promise<PlannedLine[]> {
    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    const locationIds = [
      ...new Set(
        dto.lines.flatMap((l) => (l.locationId ? [l.locationId] : [])),
      ),
    ];
    const [products, locations] = await Promise.all([
      tenant.product.findMany({
        where: { id: { in: productIds }, isActive: true },
        select: { id: true, sku: true, tracksLots: true },
      }),
      locationIds.length === 0
        ? []
        : tenant.location.findMany({
            where: { id: { in: locationIds }, warehouseId, isActive: true },
            select: { id: true },
          }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const validLocations = new Set(locations.map((l) => l.id));

    return dto.lines.map((line, index) => {
      const lineNumber = index + 1;
      const product = productById.get(line.productId);
      if (!product) throw movementErrors.productInvalid(lineNumber);
      if (product.tracksLots && !line.lotCode) {
        throw movementErrors.lotRequired(lineNumber);
      }
      if (!product.tracksLots && line.lotCode) {
        throw movementErrors.lotNotAllowed(lineNumber);
      }
      if (
        line.locationId !== undefined &&
        !validLocations.has(line.locationId)
      ) {
        throw movementErrors.locationInvalid(lineNumber);
      }
      return {
        lineNumber,
        product: { id: product.id, sku: product.sku },
        effect: lineEffect(nature, line.direction, lineNumber),
        quantity: new Decimal(line.quantity),
        locationId: line.locationId,
        lotCode: line.lotCode,
        unitCost:
          line.unitCost === undefined ? undefined : new Decimal(line.unitCost),
      };
    });
  }

  /**
   * Updates stock balances and average costs for the lines, inside the
   * movement's transaction. Locking the products first serializes concurrent
   * movements of the same product, so balances and costs never race.
   */
  private async applyLines(
    tx: Tx,
    schema: string,
    input: {
      warehouse: { id: number; defaultLocationId: number | null };
      lines: PlannedLine[];
      allowNegative: boolean;
    },
  ) {
    const { warehouse, lines, allowNegative } = input;
    const productIds = [...new Set(lines.map((l) => l.product.id))].sort(
      (a, b) => a - b,
    );
    const locked = await tx.$queryRawUnsafe<
      { id: number; averageCost: string }[]
    >(
      `SELECT "id", "average_cost"::text AS "averageCost" FROM "${schema}"."products"
        WHERE "id" = ANY($1::int[]) ORDER BY "id" FOR UPDATE`,
      productIds,
    );
    const averageCost = new Map(
      locked.map((p) => [p.id, new Decimal(p.averageCost)]),
    );
    const changedCost = new Set<number>();

    // Every warehouse of each product: on-hand across the organization drives the
    // average cost; the movement's warehouse gives the balances to change.
    const enabled = await tx.productWarehouse.findMany({
      where: { productId: { in: productIds } },
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        defaultLocationId: true,
        stockBalances: { select: { quantity: true } },
      },
    });
    const onHand = new Map<number, Decimal>(
      productIds.map((id) => [id, new Decimal(0)]),
    );
    const inWarehouse = new Map<
      number,
      { id: number; defaultLocationId: number | null }
    >();
    for (const pw of enabled) {
      const sum = pw.stockBalances.reduce(
        (total, b) => total.add(b.quantity),
        new Decimal(0),
      );
      onHand.set(pw.productId, onHand.get(pw.productId)!.add(sum));
      if (pw.warehouseId === warehouse.id) inWarehouse.set(pw.productId, pw);
    }

    const resolved: {
      lineNumber: number;
      productId: number;
      effect: Effect;
      locationId: number;
      lotId: number | null;
      quantity: Decimal;
      unitCost: Decimal;
    }[] = [];

    for (const line of lines) {
      const productId = line.product.id;
      let pw = inWarehouse.get(productId);
      if (!pw) {
        // A product is enabled in a warehouse when stock first arrives there.
        if (line.effect === 'OUT' && !allowNegative) {
          throw movementErrors.insufficientStock(
            line.lineNumber,
            line.product.sku,
          );
        }
        pw = await tx.productWarehouse.create({
          data: { productId, warehouseId: warehouse.id },
          select: { id: true, defaultLocationId: true },
        });
        inWarehouse.set(productId, pw);
      }

      const locationId =
        line.locationId ?? pw.defaultLocationId ?? warehouse.defaultLocationId;
      if (locationId === null)
        throw movementErrors.locationInvalid(line.lineNumber);

      let lotId: number | null = null;
      if (line.lotCode) {
        if (line.effect === 'IN') {
          const lot = await tx.lot.upsert({
            where: { productId_code: { productId, code: line.lotCode } },
            create: { productId, code: line.lotCode },
            update: {},
            select: { id: true },
          });
          lotId = lot.id;
        } else {
          const lot = await tx.lot.findUnique({
            where: { productId_code: { productId, code: line.lotCode } },
            select: { id: true },
          });
          if (!lot) throw movementErrors.lotNotFound(line.lineNumber);
          lotId = lot.id;
        }
      }

      const current = averageCost.get(productId)!;
      let unitCost = current;
      if (line.effect === 'IN') {
        await this.addToBalance(
          tx,
          schema,
          pw.id,
          locationId,
          lotId,
          line.quantity,
        );
        if (line.unitCost !== undefined) {
          unitCost = line.unitCost;
          averageCost.set(
            productId,
            weightedAverage(
              onHand.get(productId)!,
              current,
              line.quantity,
              unitCost,
            ),
          );
          changedCost.add(productId);
        }
        onHand.set(productId, onHand.get(productId)!.add(line.quantity));
      } else {
        if (allowNegative) {
          await this.addToBalance(
            tx,
            schema,
            pw.id,
            locationId,
            lotId,
            line.quantity.neg(),
          );
        } else {
          const updated = await tx.$executeRawUnsafe(
            `UPDATE "${schema}"."stock_balances"
                SET "quantity" = "quantity" - $4::numeric, "updated_at" = now()
              WHERE "product_warehouse_id" = $1 AND "location_id" = $2
                AND "lot_id" IS NOT DISTINCT FROM $3::int
                AND "quantity" >= $4::numeric`,
            pw.id,
            locationId,
            lotId,
            line.quantity.toString(),
          );
          if (updated === 0) {
            throw movementErrors.insufficientStock(
              line.lineNumber,
              line.product.sku,
            );
          }
        }
        onHand.set(productId, onHand.get(productId)!.sub(line.quantity));
      }

      resolved.push({
        lineNumber: line.lineNumber,
        productId,
        effect: line.effect,
        locationId,
        lotId,
        quantity: line.quantity,
        unitCost,
      });
    }

    for (const productId of changedCost) {
      await tx.product.update({
        where: { id: productId },
        data: { averageCost: averageCost.get(productId)! },
      });
    }
    return resolved;
  }

  /** Adds a (possibly negative) quantity to a balance, creating it if needed. */
  private async addToBalance(
    tx: Tx,
    schema: string,
    productWarehouseId: number,
    locationId: number,
    lotId: number | null,
    quantity: Decimal,
  ) {
    await tx.$executeRawUnsafe(
      `INSERT INTO "${schema}"."stock_balances"
              ("product_warehouse_id", "location_id", "lot_id", "quantity", "updated_at")
       VALUES ($1, $2, $3::int, $4::numeric, now())
       ON CONFLICT ("product_warehouse_id", "location_id", "lot_id")
       DO UPDATE SET "quantity" = "stock_balances"."quantity" + EXCLUDED."quantity",
                     "updated_at" = now()`,
      productWarehouseId,
      locationId,
      lotId,
      quantity.toString(),
    );
  }

  /** Joins movements with the names of the accounts that registered them. */
  private async toDtos(movements: MovementWithRefs[]): Promise<MovementDto[]> {
    const accountIds = [
      ...new Set(movements.map((m) => m.registeredBy.accountId)),
    ];
    const accounts =
      accountIds.length === 0
        ? []
        : await this.control.account.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, name: true },
          });
    const names = new Map(accounts.map((a) => [a.id, a.name]));

    return movements.map((movement) => {
      const first = movement.lines[0];
      const location = first?.originLocation ?? first?.destinationLocation;
      if (!location) throw movementErrors.notFound();
      return {
        id: movement.id,
        number: movement.number,
        status: movement.status,
        source: movement.stockRequestId === null ? 'MANUAL' : 'STOCK_REQUEST',
        movementType: movement.movementType,
        warehouse: location.warehouse,
        registeredBy: {
          id: movement.registeredBy.id,
          name: names.get(movement.registeredBy.accountId) ?? null,
        },
        department: movement.department,
        documentRef: movement.documentRef,
        notes: movement.notes,
        occurredAt: movement.occurredAt,
        lines: movement.lines.map((line) => ({
          lineNumber: line.lineNumber,
          product: {
            id: line.product.id,
            sku: line.product.sku,
            name: line.product.name,
            unit: line.product.stockUnit.code,
          },
          originLocation: line.originLocation && {
            id: line.originLocation.id,
            code: line.originLocation.code,
          },
          destinationLocation: line.destinationLocation && {
            id: line.destinationLocation.id,
            code: line.destinationLocation.code,
          },
          lot: line.lot,
          quantity: line.quantity.toNumber(),
          unitCost: line.unitCost.toNumber(),
        })),
      };
    });
  }
}
