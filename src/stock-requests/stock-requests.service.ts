import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { authErrors } from '../auth/auth-errors.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { MovementsService } from '../movements/movements.service.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  evaluateAlerts,
  stockLevels,
} from '../replenishment/evaluate-alerts.js';
import {
  type CreateStockRequestDto,
  type FulfilStockRequestDto,
  type ListStockRequestsQueryDto,
  type RejectStockRequestDto,
  StockRequestTypeValue,
} from './dto.js';
import type { StockRequestDto, StockRequestPageDto } from './responses.js';
import { stockRequestErrors } from './stock-request-errors.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;
type Status = StockRequestDto['status'];

/** Request number shown to users, derived from its id. */
export const stockRequestNumber = (id: number) =>
  `SR-${String(id).padStart(8, '0')}`;

/** Allowed status changes (RF-REQ-003, RN-016). */
const transitions: Record<Status, Status[]> = {
  PENDING: ['IN_PROGRESS', 'REJECTED', 'CANCELLED'],
  IN_PROGRESS: ['FULFILLED', 'REJECTED'],
  FULFILLED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function assertTransition(from: Status, to: Status) {
  if (!transitions[from].includes(to)) {
    throw stockRequestErrors.statusInvalid(from, to);
  }
}

const userRef = { select: { id: true, accountId: true } } as const;

const requestInclude = {
  warehouse: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
  requestedBy: userRef,
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
    },
  },
  events: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { changedBy: userRef },
  },
  movements: {
    orderBy: { id: 'asc' },
    take: 1,
    select: { id: true, number: true },
  },
} satisfies Prisma.StockRequestInclude;

type RequestWithRefs = Prisma.StockRequestGetPayload<{
  include: typeof requestInclude;
}>;

interface LockedRequest {
  id: number;
  number: string;
  status: Status;
  type: StockRequestDto['type'];
  warehouseId: number;
  departmentId: number;
  requestedById: number;
}

// CU-08 (create and read internal requests) and CU-09 (attend them). A request
// goes PENDING → IN_PROGRESS (reserves the full requested stock) → FULFILLED (an
// outbound movement with source "stock request", which feeds the demand history),
// or REJECTED with a reason; the requester can cancel it while PENDING. Every
// change is recorded in `stock_request_events` with user and date.
@Injectable()
export class StockRequestsService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
    private readonly movements: MovementsService,
  ) {}

  async list(
    auth: AuthContext,
    query: ListStockRequestsQueryDto,
  ): Promise<StockRequestPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const tenant = this.tenant(auth);
    const visible = await this.visibility(tenant, auth);

    const and: Prisma.StockRequestWhereInput[] = [visible];
    if (query.warehouseId !== undefined) {
      and.push({ warehouseId: query.warehouseId });
    }
    if (query.departmentId !== undefined) {
      and.push({ departmentId: query.departmentId });
    }
    if (query.productId !== undefined) {
      and.push({ lines: { some: { productId: query.productId } } });
    }
    if (query.status) and.push({ status: query.status });
    if (query.from) and.push({ createdAt: { gte: new Date(query.from) } });
    if (query.to) and.push({ createdAt: { lte: new Date(query.to) } });
    const where: Prisma.StockRequestWhereInput = { AND: and };

    const [total, requests] = await Promise.all([
      tenant.stockRequest.count({ where }),
      tenant.stockRequest.findMany({
        where,
        include: requestInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.toDtos(requests), total, page, pageSize };
  }

  async get(auth: AuthContext, id: number): Promise<StockRequestDto> {
    const tenant = this.tenant(auth);
    const request = await tenant.stockRequest.findFirst({
      where: { AND: [{ id }, await this.visibility(tenant, auth)] },
      include: requestInclude,
    });
    if (!request) throw stockRequestErrors.notFound();
    const [dto] = await this.toDtos([request]);
    return dto;
  }

  async create(
    auth: AuthContext,
    dto: CreateStockRequestDto,
  ): Promise<StockRequestDto> {
    const permissions = permissionsInWarehouse(
      auth.user.roles,
      dto.warehouseId,
    );
    if (!permissions.has('stock_request.create')) throw authErrors.forbidden();
    const type = dto.type ?? StockRequestTypeValue.INTERNAL_CONSUMPTION;
    if (type !== StockRequestTypeValue.INTERNAL_CONSUMPTION) {
      throw stockRequestErrors.typeNotSupported();
    }

    const tenant = this.tenant(auth);
    const productIds = dto.lines.map((l) => l.productId);
    const [user, warehouse, products] = await Promise.all([
      tenant.user.findUnique({
        where: { id: auth.user.id },
        select: { department: { select: { id: true, isActive: true } } },
      }),
      tenant.warehouse.findUnique({
        where: { id: dto.warehouseId },
        select: { isActive: true },
      }),
      tenant.product.findMany({
        where: { id: { in: productIds }, isActive: true },
        select: { id: true },
      }),
    ]);
    const department = user?.department;
    if (!department?.isActive) throw stockRequestErrors.departmentRequired();
    if (!warehouse?.isActive) throw stockRequestErrors.warehouseInvalid();
    const active = new Set(products.map((p) => p.id));
    const seen = new Set<number>();
    dto.lines.forEach((line, index) => {
      if (!active.has(line.productId)) {
        throw stockRequestErrors.productInvalid(index + 1);
      }
      if (seen.has(line.productId)) {
        throw stockRequestErrors.productDuplicated(index + 1);
      }
      seen.add(line.productId);
    });

    const schema = assertTenantSchema(auth.organization.schemaName);
    const id = await tenant.$transaction(async (tx) => {
      const [{ id }] = await tx.$queryRawUnsafe<{ id: number }[]>(
        `SELECT nextval(pg_get_serial_sequence('"${schema}"."stock_requests"', 'id'))::int AS "id"`,
      );
      await tx.stockRequest.create({
        data: {
          id,
          number: stockRequestNumber(id),
          type,
          requestedById: auth.user.id,
          departmentId: department.id,
          warehouseId: dto.warehouseId,
          priority: dto.priority ?? 2,
          requiredDate: dto.requiredDate ? new Date(dto.requiredDate) : null,
          notes: dto.notes || null,
          lines: {
            create: dto.lines.map((line, index) => ({
              lineNumber: index + 1,
              productId: line.productId,
              requestedQuantity: new Decimal(line.quantity),
            })),
          },
          events: {
            create: { status: 'PENDING', changedById: auth.user.id },
          },
        },
      });
      return id;
    });
    return this.load(tenant, id);
  }

  /** PENDING → IN_PROGRESS: reserves the full requested quantity of every line. */
  async start(auth: AuthContext, id: number): Promise<StockRequestDto> {
    const { tenant, schema } = await this.forAttention(auth, id);
    const settings = await tenant.settings.findUnique({ where: { id: 1 } });
    const allowNegative = settings?.allowNegativeStock ?? false;

    await tenant.$transaction(
      async (tx) => {
        const request = await this.lock(tx, schema, id);
        assertTransition(request.status, 'IN_PROGRESS');
        const lines = await tx.stockRequestLine.findMany({
          where: { stockRequestId: id },
          orderBy: { lineNumber: 'asc' },
          include: { product: { select: { sku: true } } },
        });
        const pws = await this.lockProducts(
          tx,
          schema,
          request.warehouseId,
          lines.map((l) => l.productId),
        );
        if (!allowNegative) {
          const levels = await stockLevels(tx, pws);
          const pwOf = new Map(pws.map((pw) => [pw.productId, pw.id]));
          for (const line of lines) {
            const pwId = pwOf.get(line.productId);
            const available = pwId === undefined ? null : levels.get(pwId)!;
            if (!available?.available.gte(line.requestedQuantity)) {
              throw stockRequestErrors.insufficientStock(
                line.lineNumber,
                line.product.sku,
              );
            }
          }
        }
        await tx.$executeRawUnsafe(
          `UPDATE "${schema}"."stock_request_lines"
              SET "reserved_quantity" = "requested_quantity"
            WHERE "stock_request_id" = $1`,
          id,
        );
        await this.setStatus(tx, id, auth.user.id, 'IN_PROGRESS');
        // Available stock dropped by the reservation.
        await evaluateAlerts(
          tx,
          pws.map((pw) => pw.id),
        );
      },
      { timeout: 20_000 },
    );
    return this.load(tenant, id);
  }

  /** PENDING or IN_PROGRESS → REJECTED with a reason; releases the reservation. */
  async reject(
    auth: AuthContext,
    id: number,
    dto: RejectStockRequestDto,
  ): Promise<StockRequestDto> {
    const { tenant, schema } = await this.forAttention(auth, id);
    await tenant.$transaction(
      async (tx) => {
        const request = await this.lock(tx, schema, id);
        assertTransition(request.status, 'REJECTED');
        if (request.status === 'IN_PROGRESS') {
          const pws = await this.releaseReservation(tx, schema, request);
          await this.setStatus(tx, id, auth.user.id, 'REJECTED', dto.reason);
          await evaluateAlerts(
            tx,
            pws.map((pw) => pw.id),
          );
        } else {
          await this.setStatus(tx, id, auth.user.id, 'REJECTED', dto.reason);
        }
      },
      { timeout: 20_000 },
    );
    return this.load(tenant, id);
  }

  /** PENDING → CANCELLED, only by the requester. */
  async cancel(auth: AuthContext, id: number): Promise<StockRequestDto> {
    await this.get(auth, id); // 404 unless visible
    const tenant = this.tenant(auth);
    const schema = assertTenantSchema(auth.organization.schemaName);
    await tenant.$transaction(async (tx) => {
      const request = await this.lock(tx, schema, id);
      if (request.requestedById !== auth.user.id) {
        throw stockRequestErrors.notRequester();
      }
      assertTransition(request.status, 'CANCELLED');
      await this.setStatus(tx, id, auth.user.id, 'CANCELLED');
    });
    return this.load(tenant, id);
  }

  /**
   * IN_PROGRESS → FULFILLED: releases the reservation and registers the outbound
   * movement (source "stock request", the request's department) in the same
   * transaction. A request already fulfilled cannot be fulfilled again.
   */
  async fulfil(
    auth: AuthContext,
    id: number,
    dto: FulfilStockRequestDto,
  ): Promise<StockRequestDto> {
    const { tenant, schema } = await this.forAttention(auth, id);
    const settings = await tenant.settings.findUnique({
      where: { id: 1 },
      include: { stockRequestMovementType: true },
    });
    const movementType = settings?.stockRequestMovementType;
    if (movementType?.nature !== 'OUTBOUND') {
      throw stockRequestErrors.movementTypeMissing();
    }
    const where = new Map((dto.lines ?? []).map((l) => [l.lineNumber, l]));

    await tenant.$transaction(
      async (tx) => {
        const request = await this.lock(tx, schema, id);
        assertTransition(request.status, 'FULFILLED');
        const lines = await tx.stockRequestLine.findMany({
          where: { stockRequestId: id },
          orderBy: { lineNumber: 'asc' },
        });
        const known = new Set(lines.map((l) => l.lineNumber));
        for (const lineNumber of where.keys()) {
          if (!known.has(lineNumber)) {
            throw stockRequestErrors.lineInvalid(lineNumber);
          }
        }
        const warehouse = await tx.warehouse.findUniqueOrThrow({
          where: { id: request.warehouseId },
          select: { id: true, defaultLocationId: true },
        });
        const planned = await this.movements.planLines(
          tx,
          warehouse.id,
          'OUTBOUND',
          lines.map((line) => ({
            productId: line.productId,
            quantity: line.requestedQuantity.toNumber(),
            locationId: where.get(line.lineNumber)?.locationId,
            lotCode: where.get(line.lineNumber)?.lotCode,
          })),
        );
        await tx.stockRequestLine.updateMany({
          where: { stockRequestId: id },
          data: { reservedQuantity: 0 },
        });
        await this.movements.record(tx, schema, {
          movementTypeId: movementType.id,
          registeredById: auth.user.id,
          warehouse,
          lines: planned,
          allowNegative: settings?.allowNegativeStock ?? false,
          departmentId: request.departmentId,
          stockRequestId: id,
          documentRef: request.number,
          notes: dto.notes || null,
        });
        await this.setStatus(tx, id, auth.user.id, 'FULFILLED');
      },
      { timeout: 20_000 },
    );
    return this.load(tenant, id);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /**
   * Requests the user can see: those of warehouses where they hold
   * `stock_request.read`, and those of their own department.
   */
  private async visibility(
    tenant: Tx,
    auth: AuthContext,
  ): Promise<Prisma.StockRequestWhereInput> {
    const warehouses = warehousesWithPermission(
      auth.user.roles,
      'stock_request.read',
    );
    if (warehouses === 'ALL') return {};
    const user = await tenant.user.findUnique({
      where: { id: auth.user.id },
      select: { departmentId: true },
    });
    const or: Prisma.StockRequestWhereInput[] = [
      { warehouseId: { in: warehouses } },
    ];
    if (user?.departmentId != null) {
      or.push({ departmentId: user.departmentId });
    }
    return { OR: or };
  }

  /** Checks `stock_request.approve` in the request's warehouse (404 if not visible). */
  private async forAttention(auth: AuthContext, id: number) {
    const request = await this.get(auth, id);
    if (
      !permissionsInWarehouse(auth.user.roles, request.warehouse.id).has(
        'stock_request.approve',
      )
    ) {
      throw authErrors.forbidden();
    }
    return {
      tenant: this.tenant(auth),
      schema: assertTenantSchema(auth.organization.schemaName),
    };
  }

  /** Locks the request's row, so its status changes one at a time. */
  private async lock(tx: Tx, schema: string, id: number) {
    const [request] = await tx.$queryRawUnsafe<LockedRequest[]>(
      `SELECT "id", "number", "status"::text AS "status", "type"::text AS "type",
              "warehouse_id" AS "warehouseId", "department_id" AS "departmentId",
              "requested_by_id" AS "requestedById"
         FROM "${schema}"."stock_requests" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
    if (!request) throw stockRequestErrors.notFound();
    return request;
  }

  /**
   * Locks the products' rows (the same lock movements take, so stock and alerts
   * never race) and returns their product-warehouses in the request's warehouse.
   */
  private async lockProducts(
    tx: Tx,
    schema: string,
    warehouseId: number,
    productIds: number[],
  ) {
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${schema}"."products"
        WHERE "id" = ANY($1::int[]) ORDER BY "id" FOR UPDATE`,
      [...new Set(productIds)],
    );
    return tx.productWarehouse.findMany({
      where: { warehouseId, productId: { in: productIds } },
      select: { id: true, productId: true, warehouseId: true },
    });
  }

  private async releaseReservation(
    tx: Tx,
    schema: string,
    request: LockedRequest,
  ) {
    const lines = await tx.stockRequestLine.findMany({
      where: { stockRequestId: request.id },
      select: { productId: true },
    });
    const pws = await this.lockProducts(
      tx,
      schema,
      request.warehouseId,
      lines.map((l) => l.productId),
    );
    await tx.stockRequestLine.updateMany({
      where: { stockRequestId: request.id },
      data: { reservedQuantity: 0 },
    });
    return pws;
  }

  private async setStatus(
    tx: Tx,
    id: number,
    userId: number,
    status: Status,
    reason?: string,
  ) {
    await tx.stockRequest.update({
      where: { id },
      data: {
        status,
        ...(status === 'REJECTED' && { rejectionReason: reason }),
        events: {
          create: { status, changedById: userId, reason: reason ?? null },
        },
      },
    });
  }

  private async load(tenant: Tx, id: number): Promise<StockRequestDto> {
    const request = await tenant.stockRequest.findUniqueOrThrow({
      where: { id },
      include: requestInclude,
    });
    const [dto] = await this.toDtos([request]);
    return dto;
  }

  /** Joins requests with the names of the accounts of their users. */
  private async toDtos(
    requests: RequestWithRefs[],
  ): Promise<StockRequestDto[]> {
    const accountIds = [
      ...new Set(
        requests.flatMap((r) => [
          r.requestedBy.accountId,
          ...r.events.map((e) => e.changedBy.accountId),
        ]),
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
    const user = (u: { id: number; accountId: number }) => ({
      id: u.id,
      name: names.get(u.accountId) ?? null,
    });

    return requests.map((request) => ({
      id: request.id,
      number: request.number,
      type: request.type,
      status: request.status,
      priority: request.priority,
      requiredDate: request.requiredDate?.toISOString().slice(0, 10) ?? null,
      warehouse: request.warehouse,
      department: request.department,
      requestedBy: user(request.requestedBy),
      notes: request.notes,
      rejectionReason: request.rejectionReason,
      movement: request.movements[0] ?? null,
      lines: request.lines.map((line) => ({
        lineNumber: line.lineNumber,
        product: {
          id: line.product.id,
          sku: line.product.sku,
          name: line.product.name,
          unit: line.product.stockUnit.code,
        },
        requestedQuantity: line.requestedQuantity.toNumber(),
        reservedQuantity: line.reservedQuantity.toNumber(),
      })),
      events: request.events.map((event) => ({
        status: event.status,
        changedBy: user(event.changedBy),
        reason: event.reason,
        createdAt: event.createdAt,
      })),
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    }));
  }
}
