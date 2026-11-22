import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  grantedPermissions,
  isOwner,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { SEARCH_DEFAULT_LIMIT, type SearchQueryDto } from './dto.js';
import type {
  SearchAlertGroupDto,
  SearchCategoryGroupDto,
  SearchProductGroupDto,
  SearchResultDto,
  SearchUserGroupDto,
  SearchWarehouseGroupDto,
} from './responses.js';

type Tenant = ReturnType<TenantPrismaService['client']>;
type Scope = 'ALL' | number[];

const matches = (text: string) => ({
  contains: text,
  mode: 'insensitive' as const,
});

// The header's search box: one request looks the text up in every module the
// user can read, a few results per group, so the client only waits once. Each
// group follows the same visibility as its own list endpoint.
@Injectable()
export class SearchService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly control: ControlPrismaService,
  ) {}

  async search(
    auth: AuthContext,
    query: SearchQueryDto,
  ): Promise<SearchResultDto> {
    const text = query.q;
    const limit = query.limit ?? SEARCH_DEFAULT_LIMIT;
    const tenant = this.tenants.client(auth.organization.schemaName);
    const granted = grantedPermissions(auth.user.roles);
    const readsCatalog = granted.has('catalog.read');
    const alertScope = warehousesWithPermission(auth.user.roles, 'alert.read');
    const userScope: Scope = isOwner(auth.user.roles)
      ? 'ALL'
      : warehousesWithPermission(auth.user.roles, 'user.read');

    const [products, categories, warehouses, alerts, users] = await Promise.all(
      [
        readsCatalog ? this.products(tenant, text, limit) : null,
        readsCatalog ? this.categories(tenant, text, limit) : null,
        this.warehouses(tenant, text, limit, this.warehouseScope(auth)),
        isEmpty(alertScope)
          ? null
          : this.alerts(tenant, text, limit, alertScope),
        isEmpty(userScope)
          ? null
          : this.users(auth, tenant, text, limit, userScope),
      ],
    );
    return { query: text, products, categories, warehouses, alerts, users };
  }

  /** Active products by code or name. */
  private async products(
    tenant: Tenant,
    text: string,
    limit: number,
  ): Promise<SearchProductGroupDto> {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      OR: [{ sku: matches(text) }, { name: matches(text) }],
    };
    const [total, items] = await Promise.all([
      tenant.product.count({ where }),
      tenant.product.findMany({
        where,
        select: {
          id: true,
          sku: true,
          name: true,
          category: { select: { name: true } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);
    return {
      total,
      items: items.map(({ category, ...product }) => ({
        ...product,
        category: category.name,
      })),
    };
  }

  /** Categories (families) by name, active or not, like the categories list. */
  private async categories(
    tenant: Tenant,
    text: string,
    limit: number,
  ): Promise<SearchCategoryGroupDto> {
    const where: Prisma.CategoryWhereInput = { name: matches(text) };
    const [total, items] = await Promise.all([
      tenant.category.count({ where }),
      tenant.category.findMany({
        where,
        select: {
          id: true,
          name: true,
          isActive: true,
          parent: { select: { name: true } },
        },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);
    return {
      total,
      items: items.map(({ parent, ...category }) => ({
        ...category,
        parent: parent?.name ?? null,
      })),
    };
  }

  /** Active warehouses the user reads, by code or name. */
  private async warehouses(
    tenant: Tenant,
    text: string,
    limit: number,
    scope: Scope,
  ): Promise<SearchWarehouseGroupDto> {
    if (isEmpty(scope)) return { items: [], total: 0 };
    const where: Prisma.WarehouseWhereInput = {
      isActive: true,
      ...(scope !== 'ALL' && { id: { in: scope } }),
      OR: [{ code: matches(text) }, { name: matches(text) }],
    };
    const [total, items] = await Promise.all([
      tenant.warehouse.count({ where }),
      tenant.warehouse.findMany({
        where,
        select: { id: true, code: true, name: true, type: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);
    return { total, items };
  }

  /**
   * Open alerts whose product (code or name) or warehouse (code or name)
   * matches, in the warehouses where the user reads alerts; most severe first.
   */
  private async alerts(
    tenant: Tenant,
    text: string,
    limit: number,
    scope: Scope,
  ): Promise<SearchAlertGroupDto> {
    const where: Prisma.AlertWhereInput = {
      status: 'OPEN',
      productWarehouse: {
        ...(scope !== 'ALL' && { warehouseId: { in: scope } }),
        OR: [
          {
            product: { OR: [{ sku: matches(text) }, { name: matches(text) }] },
          },
          {
            warehouse: {
              OR: [{ code: matches(text) }, { name: matches(text) }],
            },
          },
        ],
      },
    };
    const [total, items] = await Promise.all([
      tenant.alert.count({ where }),
      tenant.alert.findMany({
        where,
        select: {
          id: true,
          severity: true,
          productWarehouse: {
            select: {
              product: { select: { id: true, sku: true, name: true } },
              warehouse: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ severity: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);
    return {
      total,
      items: items.map(({ id, severity, productWarehouse }) => ({
        id,
        severity,
        product: productWarehouse.product,
        warehouse: productWarehouse.warehouse,
      })),
    };
  }

  /**
   * Members by name or email (the account lives in the control schema), among
   * the users the actor reads: those with an assignment on a warehouse where
   * the actor holds `user.read`, plus the actor; all of them for the Owner.
   */
  private async users(
    auth: AuthContext,
    tenant: Tenant,
    text: string,
    limit: number,
    scope: Scope,
  ): Promise<SearchUserGroupDto> {
    const members = await this.control.organizationMember.findMany({
      where: {
        organizationId: auth.organization.id,
        account: { OR: [{ name: matches(text) }, { email: matches(text) }] },
      },
      select: { account: { select: { id: true, name: true, email: true } } },
    });
    if (members.length === 0) return { items: [], total: 0 };
    const accounts = new Map(
      members.map(({ account }) => [account.id, account]),
    );

    const filters: Prisma.UserWhereInput[] = [
      { accountId: { in: [...accounts.keys()] } },
    ];
    if (scope !== 'ALL') {
      filters.push({
        OR: [
          { id: auth.user.id },
          { roleAssignments: { some: { warehouseId: { in: scope } } } },
        ],
      });
    }
    const users = await tenant.user.findMany({
      where: { AND: filters },
      select: { id: true, accountId: true, jobTitle: true, isActive: true },
    });
    const found = users
      .map(({ accountId, ...user }) => {
        const account = accounts.get(accountId)!;
        return { ...user, name: account.name, email: account.email };
      })
      .sort(
        (a, b) =>
          Number(b.isActive) - Number(a.isActive) ||
          a.name.localeCompare(b.name, 'es'),
      );
    return { total: found.length, items: found.slice(0, limit) };
  }

  /** Like the warehouses list: every one with `warehouse.manage`. */
  private warehouseScope(auth: AuthContext): Scope {
    if (grantedPermissions(auth.user.roles).has('warehouse.manage')) {
      return 'ALL';
    }
    return warehousesWithPermission(auth.user.roles, 'warehouse.read');
  }
}

const isEmpty = (scope: Scope) => scope !== 'ALL' && scope.length === 0;
