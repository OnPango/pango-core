import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AuthContext,
  isOwner,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { apiError, authErrors } from '../auth/auth-errors.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { isUniqueViolation } from '../prisma/prisma-errors.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  assertCanAssign,
  isBelowActor,
  rolePolicyErrors,
} from '../roles/role-policy.js';
import {
  type AddRoleAssignmentDto,
  type ListUsersQueryDto,
  type UpdateUserDto,
  UserStatusFilter,
} from './dto.js';
import type { UserDto } from './responses.js';

export const userErrors = {
  notFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'User not found'),
  departmentNotFound: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DEPARTMENT_NOT_FOUND',
      'Department not found or inactive',
    ),
  roleNotFound: () =>
    apiError(HttpStatus.BAD_REQUEST, 'ROLE_NOT_FOUND', 'Role not found'),
  warehouseNotFound: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found or inactive',
    ),
  duplicateAssignment: () =>
    apiError(
      HttpStatus.CONFLICT,
      'DUPLICATE_ROLE_ASSIGNMENT',
      'The user already has this role on this warehouse',
    ),
  assignmentNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'ROLE_ASSIGNMENT_NOT_FOUND',
      'Role assignment not found',
    ),
  lastOwner: () =>
    apiError(
      HttpStatus.CONFLICT,
      'LAST_OWNER',
      'The organization must keep at least one active Owner',
    ),
  selfDeactivation: () =>
    apiError(
      HttpStatus.CONFLICT,
      'SELF_DEACTIVATION',
      'You cannot deactivate your own user',
    ),
};

type Tx = Prisma.TransactionClient;

const userInclude = {
  department: { select: { id: true, name: true } },
  roleAssignments: {
    orderBy: { id: 'asc' },
    include: {
      role: {
        select: {
          id: true,
          name: true,
          isSystem: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
      warehouse: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.UserInclude;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

const rolePermissionsInclude = {
  permissions: { include: { permission: { select: { code: true } } } },
} satisfies Prisma.RoleInclude;

/** Active users holding the Owner role (a system role on every warehouse). */
const ownerWhere = {
  isActive: true,
  roleAssignments: { some: { warehouseId: null, role: { isSystem: true } } },
} satisfies Prisma.UserWhereInput;

function isOwnerUser(user: UserWithRoles): boolean {
  return user.roleAssignments.some(
    (assignment) => assignment.role.isSystem && assignment.warehouseId === null,
  );
}

// CU-02, scoped by warehouse. The Owner administers every user. Anyone else sees
// the users with a role assignment on a warehouse where they hold `user.read`,
// and manages the ones whose every assignment is on a warehouse where they hold
// `user.manage`. Roles are granted per warehouse (see role-policy.ts). Name and
// email belong to `public.accounts`, shared by every organization of the account,
// so they are read-only here. New users join through invitations.
@Injectable()
export class UsersService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
  ) {}

  async list(auth: AuthContext, query: ListUsersQueryDto): Promise<UserDto[]> {
    const filters: Prisma.UserWhereInput[] = [];
    if (query.status === UserStatusFilter.ACTIVE) {
      filters.push({ isActive: true });
    }
    if (query.status === UserStatusFilter.INACTIVE) {
      filters.push({ isActive: false });
    }
    if (query.roleId !== undefined) {
      filters.push({ roleAssignments: { some: { roleId: query.roleId } } });
    }
    if (query.warehouseId !== undefined) {
      filters.push({
        roleAssignments: { some: { warehouseId: query.warehouseId } },
      });
    }
    const visible = this.readableWarehouses(auth);
    if (visible !== 'ALL') {
      filters.push({
        OR: [
          { id: auth.user.id },
          { roleAssignments: { some: { warehouseId: { in: visible } } } },
        ],
      });
    }
    if (query.search) {
      const members = await this.control.organizationMember.findMany({
        where: {
          organizationId: auth.organization.id,
          account: {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          },
        },
        select: { accountId: true },
      });
      filters.push({ accountId: { in: members.map((m) => m.accountId) } });
    }

    const users = await this.tenant(auth).user.findMany({
      where: { AND: filters },
      include: userInclude,
    });
    const dtos = await this.toDtos(auth, users);
    return dtos.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  async get(auth: AuthContext, id: number): Promise<UserDto> {
    const user = await this.findVisible(this.tenant(auth), auth, id);
    return this.toDto(auth, user);
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateUserDto,
  ): Promise<UserDto> {
    const tenant = this.tenant(auth);
    const user = await this.findVisible(tenant, auth, id);
    this.assertCanManage(auth, user);

    const data: Prisma.UserUncheckedUpdateInput = {};
    if (dto.jobTitle !== undefined) data.jobTitle = dto.jobTitle || null;
    if (dto.departmentId !== undefined) {
      if (dto.departmentId !== null) {
        const department = await tenant.department.findUnique({
          where: { id: dto.departmentId },
        });
        if (!department?.isActive) throw userErrors.departmentNotFound();
      }
      data.departmentId = dto.departmentId;
    }

    const updated = await tenant.user.update({
      where: { id },
      data,
      include: userInclude,
    });
    return this.toDto(auth, updated);
  }

  /** Grants a role on a warehouse (or the Owner role on every warehouse). */
  async addAssignment(
    auth: AuthContext,
    id: number,
    dto: AddRoleAssignmentDto,
  ): Promise<UserDto> {
    const tenant = this.tenant(auth);
    const user = await this.findVisible(tenant, auth, id);
    if (isOwnerUser(user) && !isOwner(auth.user.roles)) {
      throw authErrors.forbidden();
    }

    const role = await tenant.role.findUnique({
      where: { id: dto.roleId },
      include: rolePermissionsInclude,
    });
    if (!role) throw userErrors.roleNotFound();
    const warehouseId = dto.warehouseId ?? null;
    if (warehouseId !== null) {
      const warehouse = await tenant.warehouse.findUnique({
        where: { id: warehouseId },
      });
      if (!warehouse?.isActive) throw userErrors.warehouseNotFound();
    }
    assertCanAssign(
      auth,
      {
        id: role.id,
        isSystem: role.isSystem,
        permissions: role.permissions.map((p) => p.permission.code),
      },
      warehouseId,
    );

    const existing = await tenant.roleAssignment.findFirst({
      where: { userId: id, roleId: role.id, warehouseId },
      select: { id: true },
    });
    if (existing) throw userErrors.duplicateAssignment();
    try {
      await tenant.roleAssignment.create({
        data: { userId: id, roleId: role.id, warehouseId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw userErrors.duplicateAssignment();
      throw error;
    }
    return this.get(auth, id);
  }

  /** Same rules as granting it; the organization keeps at least one Owner. */
  async removeAssignment(
    auth: AuthContext,
    id: number,
    assignmentId: number,
  ): Promise<UserDto> {
    const tenant = this.tenant(auth);
    const user = await this.findVisible(tenant, auth, id);
    if (isOwnerUser(user) && !isOwner(auth.user.roles)) {
      throw authErrors.forbidden();
    }

    await tenant.$transaction(async (tx) => {
      await this.lockSystemRoles(tx, auth);
      const assignment = await tx.roleAssignment.findFirst({
        where: { id: assignmentId, userId: id },
        include: { role: { include: rolePermissionsInclude } },
      });
      if (!assignment) throw userErrors.assignmentNotFound();
      assertCanAssign(
        auth,
        {
          id: assignment.role.id,
          isSystem: assignment.role.isSystem,
          permissions: assignment.role.permissions.map(
            (p) => p.permission.code,
          ),
        },
        assignment.warehouseId,
      );
      await tx.roleAssignment.delete({ where: { id: assignmentId } });
      if ((await tx.user.count({ where: ownerWhere })) === 0) {
        throw userErrors.lastOwner();
      }
    });
    return this.get(auth, id);
  }

  /**
   * Blocks the user's access to this organization and ends their sessions.
   * Their movements, requests and other history stay as they are.
   */
  async deactivate(auth: AuthContext, id: number): Promise<UserDto> {
    if (id === auth.user.id) throw userErrors.selfDeactivation();
    const tenant = this.tenant(auth);
    await this.findVisible(tenant, auth, id);

    const updated = await tenant.$transaction(async (tx) => {
      await this.lockSystemRoles(tx, auth);
      const user = await tx.user.findUniqueOrThrow({
        where: { id },
        include: userInclude,
      });
      this.assertCanManage(auth, user);
      if (!user.isActive) return user;

      const result = await tx.user.update({
        where: { id },
        data: { isActive: false },
        include: userInclude,
      });
      if ((await tx.user.count({ where: ownerWhere })) === 0) {
        throw userErrors.lastOwner();
      }
      return result;
    });

    // AuthGuard reloads the user on every request, so the access token stops
    // working right away; revoking the refresh tokens ends the sessions too.
    await this.control.refreshToken.updateMany({
      where: {
        accountId: updated.accountId,
        organizationId: auth.organization.id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return this.toDto(auth, updated);
  }

  async activate(auth: AuthContext, id: number): Promise<UserDto> {
    const tenant = this.tenant(auth);
    const user = await this.findVisible(tenant, auth, id);
    this.assertCanManage(auth, user);
    if (user.isActive) return this.toDto(auth, user);

    const updated = await tenant.user.update({
      where: { id },
      data: { isActive: true },
      include: userInclude,
    });
    return this.toDto(auth, updated);
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** Warehouses whose users the actor sees; `'ALL'` for the Owner. */
  private readableWarehouses(auth: AuthContext): 'ALL' | number[] {
    if (isOwner(auth.user.roles)) return 'ALL';
    return warehousesWithPermission(auth.user.roles, 'user.read');
  }

  /** The user, if the actor can see them (else 404, so ids reveal nothing). */
  private async findVisible(tenant: Tx, auth: AuthContext, id: number) {
    const user = await tenant.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!user) throw userErrors.notFound();
    const visible = this.readableWarehouses(auth);
    if (
      visible !== 'ALL' &&
      user.id !== auth.user.id &&
      !user.roleAssignments.some(
        (a) => a.warehouseId !== null && visible.includes(a.warehouseId),
      )
    ) {
      throw userErrors.notFound();
    }
    return user;
  }

  /**
   * Profile changes and (de)activation affect the user everywhere, so every one
   * of their assignments must be on a warehouse where the actor holds
   * `user.manage` and be below the actor's level there. Only the Owner changes
   * an Owner, and an Admin does not manage another Admin.
   */
  private assertCanManage(auth: AuthContext, user: UserWithRoles) {
    if (isOwner(auth.user.roles)) return;
    if (isOwnerUser(user)) throw authErrors.forbidden();
    const managed = warehousesWithPermission(auth.user.roles, 'user.manage');
    if (user.roleAssignments.length === 0) throw authErrors.forbidden();
    for (const assignment of user.roleAssignments) {
      const warehouseId = assignment.warehouseId;
      if (
        warehouseId === null ||
        (managed !== 'ALL' && !managed.includes(warehouseId))
      ) {
        throw authErrors.forbidden();
      }
      const role = {
        id: assignment.role.id,
        isSystem: assignment.role.isSystem,
        permissions: assignment.role.permissions.map((p) => p.permission.code),
      };
      if (!isBelowActor(auth, role, warehouseId)) {
        throw rolePolicyErrors.notBelowYours();
      }
    }
  }

  /**
   * Serializes changes that can remove an Owner, so two concurrent requests
   * cannot each remove a different last one.
   */
  private async lockSystemRoles(tx: Tx, auth: AuthContext) {
    const schema = assertTenantSchema(auth.organization.schemaName);
    await tx.$queryRawUnsafe(
      `SELECT "id" FROM "${schema}"."roles" WHERE "is_system" FOR UPDATE`,
    );
  }

  private async toDto(auth: AuthContext, user: UserWithRoles) {
    const [dto] = await this.toDtos(auth, [user]);
    if (!dto) throw userErrors.notFound();
    return dto;
  }

  /** Joins tenant users with their accounts and memberships in `public`. */
  private async toDtos(
    auth: AuthContext,
    users: UserWithRoles[],
  ): Promise<UserDto[]> {
    if (users.length === 0) return [];
    const members = await this.control.organizationMember.findMany({
      where: {
        organizationId: auth.organization.id,
        accountId: { in: users.map((u) => u.accountId) },
      },
      include: { account: { select: { email: true, name: true } } },
    });
    const byAccount = new Map(members.map((m) => [m.accountId, m]));

    // A tenant user without a membership is not part of the organization.
    return users.flatMap((user) => {
      const member = byAccount.get(user.accountId);
      if (!member) return [];
      return [
        {
          id: user.id,
          accountId: user.accountId,
          email: member.account.email,
          name: member.account.name,
          jobTitle: user.jobTitle,
          department: user.department,
          isActive: user.isActive,
          isOwner: isOwnerUser(user),
          roles: user.roleAssignments.map((assignment) => ({
            assignmentId: assignment.id,
            id: assignment.role.id,
            name: assignment.role.name,
            isSystem: assignment.role.isSystem,
            warehouse: assignment.warehouse,
          })),
          joinedAt: member.joinedAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      ];
    });
  }
}
