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
import { evaluateAlerts } from '../replenishment/evaluate-alerts.js';
import {
  AdjustmentDirection,
  type CreateMovementDto,
  type ListMovementsQueryDto,
  type ListMovementTypesQueryDto,
  type MovementLineInputDto,
  type ReceiveTransferDto,
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

export interface PlannedLine {
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
  receivedBy: { select: { id: true, accountId: true } },
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

/** A confirmed movement to record inside a caller's transaction. */
export interface MovementRecord {
  movementTypeId: number;
  registeredById: number;
  warehouse: { id: number; defaultLocationId: number | null };
  lines: PlannedLine[];
  allowNegative: boolean;
  departmentId?: number | null;
  stockRequestId?: number | null;
  documentRef?: string | null;
  notes?: string | null;
}

type Nature = 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'ADJUSTMENT';

/** Stock arriving at a location of a warehouse. */
interface Arrival {
  productId: number;
  locationId: number;
  lotId: number | null;
  quantity: Decimal;
}

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

/**
 * Effect of a line by the type's nature (adjustments carry their own direction).
 * A transfer line takes stock out of its origin; it arrives at the destination
 * when the transfer is received.
 */
export function lineEffect(
  nature: Nature,
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

/** Whether the user holds `movement.read` in any of the warehouses. */
function canRead(auth: AuthContext, warehouseIds: number[]): boolean {
  return warehouseIds.some((id) =>
    permissionsInWarehouse(auth.user.roles, id).has('movement.read'),
  );
}

/** Transfer-only fields on another kind of movement. */
function assertNoTransferFields(dto: CreateMovementDto) {
  if (
    dto.destinationWarehouseId !== undefined ||
    dto.receiveNow !== undefined
  ) {
    throw movementErrors.transferFieldsNotAllowed();
  }
  dto.lines.forEach((line, index) => {
    if (line.destinationLocationId !== undefined) {
      throw movementErrors.destinationLocationNotAllowed(index + 1);
    }
  });
}

/** The ids among `ids` that are active locations of the warehouse. */
async function activeLocations(
  tenant: Tx,
  warehouseId: number,
  ids: (number | undefined)[],
): Promise<Set<number>> {
  const wanted = [...new Set(ids.filter((id) => id !== undefined))];
  if (wanted.length === 0) return new Set();
  const found = await tenant.location.findMany({
    where: { id: { in: wanted }, warehouseId, isActive: true },
    select: { id: true },
  });
  return new Set(found.map((l) => l.id));
}

/**
 * Locks the products' rows (in id order, so concurrent movements never deadlock)
 * and reads their average cost. Every change to stock goes through it.
 */
async function lockProducts(tx: Tx, schema: string, productIds: number[]) {
  return tx.$queryRawUnsafe<{ id: number; averageCost: string }[]>(
    `SELECT "id", "average_cost"::text AS "averageCost" FROM "${schema}"."products"
      WHERE "id" = ANY($1::int[]) ORDER BY "id" FOR UPDATE`,
    [...productIds].sort((a, b) => a - b),
  );
}

/** Takes the next movement id, so the number can be derived from it. */
async function nextMovementId(tx: Tx, schema: string): Promise<number> {
  const [{ id }] = await tx.$queryRawUnsafe<{ id: number }[]>(
    `SELECT nextval(pg_get_serial_sequence('"${schema}"."movements"', 'id'))::int AS "id"`,
  );
  return id;
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
// CU-16: transfers between warehouses leave the origin and either arrive at once
// or stay IN_TRANSIT until the destination receives them.
// Stock cannot go negative (RN-005) unless `settings.allow_negative_stock`.
// Each movement re-evaluates the replenishment alerts it affects (CU-12a).
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
    const destination = query.destinationWarehouseId;
    if (
      destination !== undefined &&
      visible !== 'ALL' &&
      !visible.includes(destination)
    ) {
      return empty;
    }

    const and: Prisma.MovementWhereInput[] = [];
    if (warehouseIds) and.push(inWarehouses(warehouseIds));
    if (destination !== undefined) {
      and.push({
        lines: {
          some: { destinationLocation: { warehouseId: destination } },
        },
      });
    }
    if (query.status) and.push({ status: query.status });
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
    const warehouses = [dto.warehouse.id];
    if (dto.destinationWarehouse) warehouses.push(dto.destinationWarehouse.id);
    if (!canRead(auth, warehouses)) throw movementErrors.notFound();
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
    const transfer = nature === 'TRANSFER';
    if (!transfer) assertNoTransferFields(dto);

    const allowed = await tenant.movementType.findFirst({
      where: { id: type.id, ...registrableBy(auth.user.id, warehouse.id) },
      select: { id: true },
    });
    if (!allowed) throw movementErrors.typeNotAllowed();

    if (dto.departmentId !== undefined) {
      if (transfer) throw movementErrors.departmentNotAllowed();
      const department = await tenant.department.findUnique({
        where: { id: dto.departmentId },
      });
      if (!department?.isActive) throw movementErrors.departmentInvalid();
    }

    const allowNegative = settings?.allowNegativeStock ?? false;
    if (transfer) {
      return this.createTransfer(auth, dto, warehouse, type.id, allowNegative);
    }

    const lines = await this.planLines(tenant, warehouse.id, nature, dto.lines);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const id = await tenant.$transaction(
      (tx) =>
        this.record(tx, schema, {
          movementTypeId: type.id,
          registeredById: auth.user.id,
          warehouse,
          lines,
          allowNegative,
          departmentId: dto.departmentId ?? null,
          documentRef: dto.documentRef || null,
          notes: dto.notes || null,
        }),
      { timeout: 20_000 },
    );

    return this.getById(tenant, id);
  }

  /**
   * CU-16: the stock leaves the origin now. With `receiveNow` it arrives at the
   * destination in the same transaction; otherwise it stays in transit (on no
   * warehouse's balance) until `receive`.
   */
  private async createTransfer(
    auth: AuthContext,
    dto: CreateMovementDto,
    origin: { id: number; defaultLocationId: number | null },
    movementTypeId: number,
    allowNegative: boolean,
  ): Promise<MovementDto> {
    const destinationId = dto.destinationWarehouseId;
    if (destinationId === undefined) throw movementErrors.destinationRequired();
    if (destinationId === origin.id) throw movementErrors.sameWarehouse();
    const receiveNow = dto.receiveNow ?? false;
    if (
      receiveNow &&
      !permissionsInWarehouse(auth.user.roles, destinationId).has(
        'movement.receive',
      )
    ) {
      throw authErrors.forbidden();
    }

    const tenant = this.tenant(auth);
    const destination = await tenant.warehouse.findUnique({
      where: { id: destinationId },
    });
    if (!destination?.isActive) throw movementErrors.destinationInvalid();

    const lines = await this.planLines(
      tenant,
      origin.id,
      'TRANSFER',
      dto.lines,
    );
    const valid = await activeLocations(
      tenant,
      destination.id,
      dto.lines.map((l) => l.destinationLocationId),
    );
    dto.lines.forEach((line, index) => {
      const chosen = line.destinationLocationId;
      if (chosen !== undefined && !valid.has(chosen)) {
        throw movementErrors.destinationLocationInvalid(index + 1);
      }
    });

    const schema = assertTenantSchema(auth.organization.schemaName);
    const id = await tenant.$transaction(
      async (tx) => {
        const { resolved, productWarehouseIds } = await this.applyLines(
          tx,
          schema,
          { warehouse: origin, lines, allowNegative },
        );

        // Where each line arrives: the chosen location, or the product's default
        // location in the destination, or the destination's default location.
        const enabled = await tx.productWarehouse.findMany({
          where: {
            warehouseId: destination.id,
            productId: { in: resolved.map((l) => l.productId) },
          },
          select: { productId: true, defaultLocationId: true },
        });
        const defaults = new Map(
          enabled.map((pw) => [pw.productId, pw.defaultLocationId]),
        );
        const arriving = resolved.map((line) => {
          const locationId =
            dto.lines[line.lineNumber - 1].destinationLocationId ??
            defaults.get(line.productId) ??
            destination.defaultLocationId;
          if (locationId === null) {
            throw movementErrors.destinationLocationInvalid(line.lineNumber);
          }
          return { ...line, destinationLocationId: locationId };
        });

        const affected = [...productWarehouseIds];
        if (receiveNow) {
          affected.push(
            ...(await this.addToWarehouse(
              tx,
              schema,
              destination.id,
              arriving.map((line) => ({
                productId: line.productId,
                locationId: line.destinationLocationId,
                lotId: line.lotId,
                quantity: line.quantity,
              })),
            )),
          );
        }
        await evaluateAlerts(tx, affected);

        const id = await nextMovementId(tx, schema);
        await tx.movement.create({
          data: {
            id,
            number: movementNumber(id),
            movementTypeId,
            registeredById: auth.user.id,
            status: receiveNow ? 'CONFIRMED' : 'IN_TRANSIT',
            receivedById: receiveNow ? auth.user.id : null,
            receivedAt: receiveNow ? new Date() : null,
            documentRef: dto.documentRef || null,
            notes: dto.notes || null,
            lines: {
              create: arriving.map((line) => ({
                lineNumber: line.lineNumber,
                productId: line.productId,
                originLocationId: line.locationId,
                destinationLocationId: line.destinationLocationId,
                lotId: line.lotId,
                quantity: line.quantity,
                receivedQuantity: receiveNow ? line.quantity : null,
                unitCost: line.unitCost,
              })),
            },
          },
        });
        return id;
      },
      { timeout: 20_000 },
    );
    return this.getById(tenant, id);
  }

  /**
   * CU-16: the destination receives a transfer in transit. Each line adds what
   * arrived (all of it unless `dto.lines` says otherwise) at its destination
   * location; anything short is lost in transit and does not return to the origin.
   */
  async receive(
    auth: AuthContext,
    id: number,
    dto: ReceiveTransferDto,
  ): Promise<MovementDto> {
    const tenant = this.tenant(auth);
    const movement = await tenant.movement.findUnique({
      where: { id },
      select: {
        status: true,
        movementType: { select: { nature: true } },
        lines: {
          orderBy: { lineNumber: 'asc' },
          select: {
            lineNumber: true,
            productId: true,
            lotId: true,
            quantity: true,
            destinationLocationId: true,
            originLocation: { select: { warehouseId: true } },
            destinationLocation: { select: { warehouseId: true } },
          },
        },
      },
    });
    const first = movement?.lines[0];
    const warehouses = [
      first?.originLocation?.warehouseId,
      first?.destinationLocation?.warehouseId,
    ].filter((w) => w !== undefined);
    if (!movement || !canRead(auth, warehouses)) {
      throw movementErrors.notFound();
    }
    const destinationId = first?.destinationLocation?.warehouseId;
    if (
      movement.movementType.nature !== 'TRANSFER' ||
      movement.status !== 'IN_TRANSIT' ||
      destinationId === undefined
    ) {
      throw movementErrors.notInTransit();
    }
    if (
      !permissionsInWarehouse(auth.user.roles, destinationId).has(
        'movement.receive',
      )
    ) {
      throw authErrors.forbidden();
    }
    const destination = await tenant.warehouse.findUnique({
      where: { id: destinationId },
    });
    if (!destination?.isActive) throw movementErrors.destinationInvalid();

    const sent = new Map(movement.lines.map((l) => [l.lineNumber, l]));
    const changes = new Map<
      number,
      { quantity: Decimal; locationId?: number }
    >();
    for (const input of dto.lines ?? []) {
      const line = sent.get(input.lineNumber);
      if (!line || changes.has(input.lineNumber)) {
        throw movementErrors.receiptLineInvalid(input.lineNumber);
      }
      const quantity = new Decimal(input.receivedQuantity);
      if (quantity.gt(line.quantity)) {
        throw movementErrors.receivedQuantityInvalid(input.lineNumber);
      }
      changes.set(input.lineNumber, { quantity, locationId: input.locationId });
    }
    const valid = await activeLocations(
      tenant,
      destinationId,
      [...changes.values()].map((c) => c.locationId),
    );
    for (const [lineNumber, change] of changes) {
      if (change.locationId !== undefined && !valid.has(change.locationId)) {
        throw movementErrors.destinationLocationInvalid(lineNumber);
      }
    }

    const receipt = movement.lines.map((line) => {
      const change = changes.get(line.lineNumber);
      return {
        lineNumber: line.lineNumber,
        productId: line.productId,
        lotId: line.lotId,
        quantity: change?.quantity ?? line.quantity,
        locationId: change?.locationId ?? line.destinationLocationId!,
      };
    });

    const schema = assertTenantSchema(auth.organization.schemaName);
    await tenant.$transaction(
      async (tx) => {
        // Claiming the transfer first means two receipts can never both apply.
        const claimed = await tx.movement.updateMany({
          where: { id, status: 'IN_TRANSIT' },
          data: {
            status: 'CONFIRMED',
            receivedById: auth.user.id,
            receivedAt: new Date(),
          },
        });
        if (claimed.count === 0) throw movementErrors.notInTransit();

        await lockProducts(tx, schema, [
          ...new Set(receipt.map((l) => l.productId)),
        ]);
        const affected = await this.addToWarehouse(
          tx,
          schema,
          destinationId,
          receipt.filter((l) => l.quantity.gt(0)),
        );
        for (const line of receipt) {
          await tx.movementLine.update({
            where: {
              movementId_lineNumber: {
                movementId: id,
                lineNumber: line.lineNumber,
              },
            },
            data: {
              receivedQuantity: line.quantity,
              destinationLocationId: line.locationId,
            },
          });
        }
        await evaluateAlerts(tx, affected);
      },
      { timeout: 20_000 },
    );
    return this.getById(tenant, id);
  }

  /** Reads one movement as a DTO, without access checks. */
  async getById(tenant: Tx, id: number): Promise<MovementDto> {
    const movement = await tenant.movement.findUniqueOrThrow({
      where: { id },
      include: movementInclude,
    });
    const [result] = await this.toDtos([movement]);
    return result;
  }

  /**
   * Records a confirmed movement inside the caller's transaction: updates stock
   * balances and average costs, re-evaluates the stock alerts it affects (CU-12a)
   * and returns the new movement's id. Lock the products' rows through it only.
   */
  async record(tx: Tx, schema: string, input: MovementRecord): Promise<number> {
    const { resolved, productWarehouseIds } = await this.applyLines(
      tx,
      schema,
      input,
    );
    // The products' rows are locked, so alerts cannot race.
    await evaluateAlerts(tx, productWarehouseIds);
    const id = await nextMovementId(tx, schema);
    await tx.movement.create({
      data: {
        id,
        number: movementNumber(id),
        movementTypeId: input.movementTypeId,
        registeredById: input.registeredById,
        departmentId: input.departmentId ?? null,
        stockRequestId: input.stockRequestId ?? null,
        status: 'CONFIRMED',
        documentRef: input.documentRef ?? null,
        notes: input.notes ?? null,
        lines: {
          create: resolved.map((line) => ({
            lineNumber: line.lineNumber,
            productId: line.productId,
            originLocationId: line.effect === 'OUT' ? line.locationId : null,
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
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** Validates the lines against the catalog and the warehouse's locations. */
  async planLines(
    tenant: Tx,
    warehouseId: number,
    nature: Nature,
    inputLines: MovementLineInputDto[],
  ): Promise<PlannedLine[]> {
    const productIds = [...new Set(inputLines.map((l) => l.productId))];
    const locationIds = [
      ...new Set(
        inputLines.flatMap((l) => (l.locationId ? [l.locationId] : [])),
      ),
    ];
    // Sequential: stock requests call this inside a transaction (one connection).
    const products = await tenant.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: { id: true, sku: true, tracksLots: true },
    });
    const locations =
      locationIds.length === 0
        ? []
        : await tenant.location.findMany({
            where: { id: { in: locationIds }, warehouseId, isActive: true },
            select: { id: true },
          });
    const productById = new Map(products.map((p) => [p.id, p]));
    const validLocations = new Set(locations.map((l) => l.id));

    return inputLines.map((line, index) => {
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
    input: Pick<MovementRecord, 'warehouse' | 'lines' | 'allowNegative'>,
  ) {
    const { warehouse, lines, allowNegative } = input;
    const productIds = [...new Set(lines.map((l) => l.product.id))].sort(
      (a, b) => a - b,
    );
    const locked = await lockProducts(tx, schema, productIds);
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
    if (lines.some((l) => l.effect === 'IN' && l.unitCost !== undefined)) {
      // Stock in transit is still the organization's: it weighs in the average.
      const inTransit = await tx.movementLine.groupBy({
        by: ['productId'],
        where: {
          productId: { in: productIds },
          movement: { status: 'IN_TRANSIT' },
        },
        _sum: { quantity: true },
      });
      for (const row of inTransit) {
        if (row._sum.quantity) {
          onHand.set(
            row.productId,
            onHand.get(row.productId)!.add(row._sum.quantity),
          );
        }
      }
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
    const productWarehouseIds = [
      ...new Set([...inWarehouse.values()].map((pw) => pw.id)),
    ];
    return { resolved, productWarehouseIds };
  }

  /**
   * Adds arriving stock to a warehouse, enabling the products there when needed,
   * and returns the affected product-warehouses. The caller holds the products'
   * row locks.
   */
  private async addToWarehouse(
    tx: Tx,
    schema: string,
    warehouseId: number,
    arrivals: Arrival[],
  ): Promise<number[]> {
    if (arrivals.length === 0) return [];
    const productIds = [...new Set(arrivals.map((a) => a.productId))];
    const existing = await tx.productWarehouse.findMany({
      where: { warehouseId, productId: { in: productIds } },
      select: { id: true, productId: true },
    });
    const pwByProduct = new Map(existing.map((pw) => [pw.productId, pw.id]));
    for (const productId of productIds) {
      if (pwByProduct.has(productId)) continue;
      const created = await tx.productWarehouse.create({
        data: { productId, warehouseId },
        select: { id: true },
      });
      pwByProduct.set(productId, created.id);
    }
    for (const arrival of arrivals) {
      await this.addToBalance(
        tx,
        schema,
        pwByProduct.get(arrival.productId)!,
        arrival.locationId,
        arrival.lotId,
        arrival.quantity,
      );
    }
    return [...new Set(pwByProduct.values())];
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
      ...new Set(
        movements.flatMap((m) =>
          m.receivedBy
            ? [m.registeredBy.accountId, m.receivedBy.accountId]
            : [m.registeredBy.accountId],
        ),
      ),
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
      const transfer = movement.movementType.nature === 'TRANSFER';
      return {
        id: movement.id,
        number: movement.number,
        status: movement.status,
        source: movement.stockRequestId === null ? 'MANUAL' : 'STOCK_REQUEST',
        movementType: movement.movementType,
        warehouse: location.warehouse,
        destinationWarehouse: transfer
          ? (first.destinationLocation?.warehouse ?? null)
          : null,
        registeredBy: {
          id: movement.registeredBy.id,
          name: names.get(movement.registeredBy.accountId) ?? null,
        },
        receivedBy: movement.receivedBy && {
          id: movement.receivedBy.id,
          name: names.get(movement.receivedBy.accountId) ?? null,
        },
        receivedAt: movement.receivedAt,
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
          receivedQuantity: line.receivedQuantity?.toNumber() ?? null,
          unitCost: line.unitCost.toNumber(),
        })),
      };
    });
  }
}
