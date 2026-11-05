import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { apiError, authErrors } from '../auth/auth-errors.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  type ListUsersQueryDto,
  type RoleAssignmentInputDto,
  type SetUserRolesDto,
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
      HttpStatus.BAD_REQUEST,
      'DUPLICATE_ROLE_ASSIGNMENT',
      'The same role is assigned twice on the same warehouse',
    ),
  lastAdmin: () =>
    apiError(
      HttpStatus.CONFLICT,
      'LAST_ADMIN',
      'The organization must keep at least one active administrator',
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
      role: { select: { id: true, name: true, isSystem: true } },
      warehouse: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.UserInclude;

type UserWithRoles = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Active users holding a system role (Owner) on every warehouse. */
const adminWhere = {
  isActive: true,
  roleAssignments: { some: { warehouseId: null, role: { isSystem: true } } },
} satisfies Prisma.UserWhereInput;

function isAdmin(user: UserWithRoles): boolean {
  return user.roleAssignments.some(
    (assignment) => assignment.role.isSystem && assignment.warehouseId === null,
  );
}

function actorIsAdmin(auth: AuthContext): boolean {
  return auth.user.roles.some((r) => r.isSystem && r.warehouse === null);
}

// CU-02: the organization's users are tenant `users` rows; their name and email
// live in `public.accounts`, shared by every organization of the account, so they
// are read-only here. New users join through invitations (src/invitations).
@Injectable()
export class UsersService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
  ) {}

  async list(auth: AuthContext, query: ListUsersQueryDto): Promise<UserDto[]> {
    const where: Prisma.UserWhereInput = {};
    if (query.status === UserStatusFilter.ACTIVE) where.isActive = true;
    if (query.status === UserStatusFilter.INACTIVE) where.isActive = false;
    if (query.roleId !== undefined) {
      where.roleAssignments = { some: { roleId: query.roleId } };
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
      where.accountId = { in: members.map((m) => m.accountId) };
    }

    const users = await this.tenant(auth).user.findMany({
      where,
      include: userInclude,
    });
    const dtos = await this.toDtos(auth, users);
    return dtos.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  async get(auth: AuthContext, id: number): Promise<UserDto> {
    const user = await this.tenant(auth).user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!user) throw userErrors.notFound();
    return this.toDto(auth, user);
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateUserDto,
  ): Promise<UserDto> {
    const tenant = this.tenant(auth);
    const user = await tenant.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!user) throw userErrors.notFound();
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

  /** Replaces every role assignment of the user. */
  async setRoles(
    auth: AuthContext,
    id: number,
    dto: SetUserRolesDto,
  ): Promise<UserDto> {
    const keys = dto.roles.map((r) => `${r.roleId}:${r.warehouseId ?? '*'}`);
    if (new Set(keys).size !== keys.length) {
      throw userErrors.duplicateAssignment();
    }

    const updated = await this.tenant(auth).$transaction(async (tx) => {
      await this.lockSystemRoles(tx, auth);
      const user = await tx.user.findUnique({
        where: { id },
        include: userInclude,
      });
      if (!user) throw userErrors.notFound();
      this.assertCanManage(auth, user);
      await this.assertAssignable(tx, auth, dto.roles);

      await tx.roleAssignment.deleteMany({ where: { userId: id } });
      await tx.roleAssignment.createMany({
        data: dto.roles.map((r) => ({
          userId: id,
          roleId: r.roleId,
          warehouseId: r.warehouseId ?? null,
        })),
      });
      // Checked after the change, inside the transaction: it rolls back on failure.
      if ((await tx.user.count({ where: adminWhere })) === 0) {
        throw userErrors.lastAdmin();
      }
      return tx.user.findUniqueOrThrow({
        where: { id },
        include: userInclude,
      });
    });
    return this.toDto(auth, updated);
  }

  /**
   * Blocks the user's access to this organization and ends their sessions.
   * Their movements, requests and other history stay as they are.
   */
  async deactivate(auth: AuthContext, id: number): Promise<UserDto> {
    if (id === auth.user.id) throw userErrors.selfDeactivation();

    const updated = await this.tenant(auth).$transaction(async (tx) => {
      await this.lockSystemRoles(tx, auth);
      const user = await tx.user.findUnique({
        where: { id },
        include: userInclude,
      });
      if (!user) throw userErrors.notFound();
      this.assertCanManage(auth, user);
      if (!user.isActive) return user;

      const result = await tx.user.update({
        where: { id },
        data: { isActive: false },
        include: userInclude,
      });
      if ((await tx.user.count({ where: adminWhere })) === 0) {
        throw userErrors.lastAdmin();
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
    const user = await tenant.user.findUnique({
      where: { id },
      include: userInclude,
    });
    if (!user) throw userErrors.notFound();
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

  /** Only administrators can change another administrator. */
  private assertCanManage(auth: AuthContext, user: UserWithRoles) {
    if (isAdmin(user) && !actorIsAdmin(auth)) throw authErrors.forbidden();
  }

  private async assertAssignable(
    tx: Tx,
    auth: AuthContext,
    assignments: RoleAssignmentInputDto[],
  ) {
    const roleIds = [...new Set(assignments.map((a) => a.roleId))];
    const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
    if (roles.length !== roleIds.length) throw userErrors.roleNotFound();
    // Same rule as invitations: only administrators grant system roles.
    if (roles.some((role) => role.isSystem) && !actorIsAdmin(auth)) {
      throw authErrors.forbidden();
    }

    const warehouseIds = [
      ...new Set(
        assignments.flatMap((a) =>
          a.warehouseId === undefined ? [] : [a.warehouseId],
        ),
      ),
    ];
    if (warehouseIds.length > 0) {
      const active = await tx.warehouse.count({
        where: { id: { in: warehouseIds }, isActive: true },
      });
      if (active !== warehouseIds.length) throw userErrors.warehouseNotFound();
    }
  }

  /**
   * Serializes changes that can remove an administrator, so two concurrent
   * requests cannot each remove a different last admin.
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
          isAdmin: isAdmin(user),
          roles: user.roleAssignments.map((assignment) => ({
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
