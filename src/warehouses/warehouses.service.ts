import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AuthContext,
  grantedPermissions,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { apiError } from '../auth/auth-errors.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { isUniqueViolation } from '../prisma/prisma-errors.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  evaluateAlerts,
  lockAlertScope,
} from '../replenishment/evaluate-alerts.js';
import {
  type CreateWarehouseDto,
  type ListWarehousesQueryDto,
  type UpdateWarehouseDto,
  WarehouseStatusFilter,
} from './dto.js';
import type { WarehouseDto } from './responses.js';

/** Code of the location every warehouse is created with. */
export const DEFAULT_LOCATION_CODE = 'DEFAULT';

export const warehouseErrors = {
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found',
    ),
  nameTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'WAREHOUSE_NAME_TAKEN',
      'A warehouse with this name already exists in the organization',
    ),
  codeTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'WAREHOUSE_CODE_TAKEN',
      'A warehouse with this code already exists in the organization',
    ),
  hasStock: () =>
    apiError(
      HttpStatus.CONFLICT,
      'WAREHOUSE_HAS_STOCK',
      'A warehouse with stock on hand cannot be deactivated',
    ),
  hasTransfersInTransit: () =>
    apiError(
      HttpStatus.CONFLICT,
      'WAREHOUSE_HAS_TRANSFERS_IN_TRANSIT',
      'A warehouse with transfers in transit, to or from it, cannot be deactivated',
    ),
};

type Tx = Prisma.TransactionClient;

const warehouseInclude = {
  defaultLocation: { select: { id: true, code: true } },
} satisfies Prisma.WarehouseInclude;

type WarehouseWithLocation = Prisma.WarehouseGetPayload<{
  include: typeof warehouseInclude;
}>;

/**
 * Creates a warehouse and its default location (RN-002) inside the caller's
 * transaction. `POST /warehouses` and the inventory import both use it, so a
 * warehouse is always born the same way.
 */
export async function createWarehouseWithDefaultLocation(
  tx: Tx,
  data: Pick<
    Prisma.WarehouseUncheckedCreateInput,
    'code' | 'name' | 'type' | 'address' | 'holdsStock'
  >,
): Promise<WarehouseWithLocation> {
  const created = await tx.warehouse.create({ data });
  const location = await tx.location.create({
    data: { warehouseId: created.id, code: DEFAULT_LOCATION_CODE },
  });
  return tx.warehouse.update({
    where: { id: created.id },
    data: { defaultLocationId: location.id },
    include: warehouseInclude,
  });
}

function toDto(warehouse: WarehouseWithLocation): WarehouseDto {
  return {
    id: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
    type: warehouse.type,
    address: warehouse.address,
    defaultLocation: warehouse.defaultLocation,
    holdsStock: warehouse.holdsStock,
    isActive: warehouse.isActive,
    createdAt: warehouse.createdAt,
    updatedAt: warehouse.updatedAt,
  };
}

// CU-04: the organization's warehouses (storage warehouses and stores). Each one
// is created with a default location (RN-002) and is deactivated, never deleted.
// Reading is warehouse-scoped: a user sees the warehouses where they hold
// `warehouse.read` (all of them with an assignment that has no warehouse).
@Injectable()
export class WarehousesService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async list(
    auth: AuthContext,
    query: ListWarehousesQueryDto,
  ): Promise<WarehouseDto[]> {
    const visible = this.visibleWarehouses(auth);
    const status = query.status ?? WarehouseStatusFilter.ACTIVE;

    const where: Prisma.WarehouseWhereInput = {};
    if (visible !== 'ALL') where.id = { in: visible };
    if (status === WarehouseStatusFilter.ACTIVE) where.isActive = true;
    if (status === WarehouseStatusFilter.INACTIVE) where.isActive = false;
    if (query.type) where.type = query.type;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const warehouses = await this.tenant(auth).warehouse.findMany({
      where,
      include: warehouseInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return warehouses.map(toDto);
  }

  async get(auth: AuthContext, id: number): Promise<WarehouseDto> {
    const visible = this.visibleWarehouses(auth);
    if (visible !== 'ALL' && !visible.includes(id)) {
      throw warehouseErrors.notFound();
    }
    const warehouse = await this.tenant(auth).warehouse.findUnique({
      where: { id },
      include: warehouseInclude,
    });
    if (!warehouse) throw warehouseErrors.notFound();
    return toDto(warehouse);
  }

  /** Creates the warehouse and its default location in one transaction. */
  async create(
    auth: AuthContext,
    dto: CreateWarehouseDto,
  ): Promise<WarehouseDto> {
    const tenant = this.tenant(auth);
    await this.assertUnique(tenant, dto.code, dto.name);

    try {
      const warehouse = await tenant.$transaction((tx) =>
        createWarehouseWithDefaultLocation(tx, {
          code: dto.code,
          name: dto.name,
          type: dto.type,
          address: dto.address || null,
          holdsStock: dto.holdsStock ?? true,
        }),
      );
      return toDto(warehouse);
    } catch (error) {
      if (isUniqueViolation(error)) throw warehouseErrors.codeTaken();
      throw error;
    }
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateWarehouseDto,
  ): Promise<WarehouseDto> {
    const tenant = this.tenant(auth);
    const warehouse = await tenant.warehouse.findUnique({ where: { id } });
    if (!warehouse) throw warehouseErrors.notFound();

    const data: Prisma.WarehouseUncheckedUpdateInput = {};
    if (dto.code !== undefined && dto.code !== warehouse.code) {
      await this.assertUnique(tenant, dto.code, undefined, id);
      data.code = dto.code;
    }
    if (dto.name !== undefined && dto.name !== warehouse.name) {
      await this.assertUnique(tenant, undefined, dto.name, id);
      data.name = dto.name;
    }
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.address !== undefined) data.address = dto.address || null;
    if (dto.holdsStock !== undefined) data.holdsStock = dto.holdsStock;
    if (dto.isActive !== undefined && dto.isActive !== warehouse.isActive) {
      if (!dto.isActive && (await this.hasStock(tenant, id))) {
        throw warehouseErrors.hasStock();
      }
      if (!dto.isActive && (await this.hasTransfersInTransit(tenant, id))) {
        throw warehouseErrors.hasTransfersInTransit();
      }
      data.isActive = dto.isActive;
    }
    const statusChanged = data.isActive !== undefined;
    const schema = assertTenantSchema(auth.organization.schemaName);

    try {
      const updated = await tenant.$transaction(async (tx) => {
        // Closing resolves the open alerts of its products there (INACTIVE):
        // without stock or movements nothing would evaluate them again.
        // Reopening may raise them again.
        const scope = statusChanged
          ? await lockAlertScope(tx, schema, { warehouseId: id })
          : [];
        const row = await tx.warehouse.update({
          where: { id },
          data,
          include: warehouseInclude,
        });
        await evaluateAlerts(tx, scope);
        return row;
      });
      return toDto(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw warehouseErrors.codeTaken();
      throw error;
    }
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /**
   * `warehouse.manage` is an ORGANIZATION-scope permission, so its holders see
   * every warehouse; anyone else, the ones where they hold `warehouse.read`.
   */
  private visibleWarehouses(auth: AuthContext): 'ALL' | number[] {
    if (grantedPermissions(auth.user.roles).has('warehouse.manage')) {
      return 'ALL';
    }
    return warehousesWithPermission(auth.user.roles, 'warehouse.read');
  }

  private async assertUnique(
    tenant: Tx,
    code: string | undefined,
    name: string | undefined,
    exceptId?: number,
  ) {
    const others = exceptId === undefined ? {} : { id: { not: exceptId } };
    if (code !== undefined) {
      const existing = await tenant.warehouse.findFirst({
        where: { code: { equals: code, mode: 'insensitive' }, ...others },
        select: { id: true },
      });
      if (existing) throw warehouseErrors.codeTaken();
    }
    if (name !== undefined) {
      const existing = await tenant.warehouse.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, ...others },
        select: { id: true },
      });
      if (existing) throw warehouseErrors.nameTaken();
    }
  }

  private async hasStock(tenant: Tx, warehouseId: number) {
    const balance = await tenant.stockBalance.findFirst({
      where: { productWarehouse: { warehouseId }, quantity: { not: 0 } },
      select: { id: true },
    });
    return balance !== null;
  }

  /** Transfers leaving or reaching the warehouse that are not received yet. */
  private async hasTransfersInTransit(tenant: Tx, warehouseId: number) {
    const transfer = await tenant.movement.findFirst({
      where: {
        status: 'IN_TRANSIT',
        lines: {
          some: {
            OR: [
              { originLocation: { warehouseId } },
              { destinationLocation: { warehouseId } },
            ],
          },
        },
      },
      select: { id: true },
    });
    return transfer !== null;
  }
}
