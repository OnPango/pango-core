import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AuthContext,
  grantedPermissions,
  isOwner,
} from '../auth/auth-context.js';
import { apiError } from '../auth/auth-errors.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { isUniqueViolation } from '../prisma/prisma-errors.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import type { CreateRoleDto, UpdateRoleDto } from './dto.js';
import type { PermissionDto, RoleDto } from './responses.js';

export const roleErrors = {
  notFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'ROLE_NOT_FOUND', 'Role not found'),
  nameTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'ROLE_NAME_TAKEN',
      'A role with this name already exists',
    ),
  systemLocked: () =>
    apiError(
      HttpStatus.CONFLICT,
      'ROLE_SYSTEM_LOCKED',
      'System roles (Owner) cannot be edited or deleted',
    ),
  inUse: () =>
    apiError(
      HttpStatus.CONFLICT,
      'ROLE_IN_USE',
      'The role is assigned to users or pending invitations; remove them first',
    ),
  permissionNotFound: (codes: string[]) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'PERMISSION_NOT_FOUND',
      `Unknown permissions: ${codes.join(', ')}`,
    ),
  exceedsYourPermissions: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'ROLE_EXCEEDS_YOUR_PERMISSIONS',
      'You cannot give a role permissions you do not hold',
    ),
  ownRole: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'ROLE_HELD_BY_YOU',
      'Only the Owner can edit a role you hold',
    ),
};

type Tx = Prisma.TransactionClient;

const roleInclude = {
  permissions: { include: { permission: { select: { code: true } } } },
  _count: { select: { assignments: true } },
} satisfies Prisma.RoleInclude;

type RoleWithPermissions = Prisma.RoleGetPayload<{
  include: typeof roleInclude;
}>;

function toDto(role: RoleWithPermissions): RoleDto {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: role.permissions.map((p) => p.permission.code).sort(),
    assignmentCount: role._count.assignments,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

// CU-14: the Owner decides what each role can do. Roles are organization-wide;
// assigning them is per warehouse (see role-policy.ts). System roles (Owner) are
// fixed. Anyone else allowed to manage roles cannot edit a role they hold nor
// give a role permissions they do not hold, so they cannot escalate.
@Injectable()
export class RolesService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
  ) {}

  async listPermissions(auth: AuthContext): Promise<PermissionDto[]> {
    return this.tenant(auth).permission.findMany({
      select: { code: true, module: true, scope: true, description: true },
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });
  }

  async list(auth: AuthContext): Promise<RoleDto[]> {
    const roles = await this.tenant(auth).role.findMany({
      include: roleInclude,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map(toDto);
  }

  async get(auth: AuthContext, id: number): Promise<RoleDto> {
    const role = await this.tenant(auth).role.findUnique({
      where: { id },
      include: roleInclude,
    });
    if (!role) throw roleErrors.notFound();
    return toDto(role);
  }

  /** New roles may register every movement type, like the seeded ones. */
  async create(auth: AuthContext, dto: CreateRoleDto): Promise<RoleDto> {
    const tenant = this.tenant(auth);
    await this.assertNameFree(tenant, dto.name);
    const permissionIds = await this.resolvePermissions(
      tenant,
      auth,
      dto.permissions,
    );

    try {
      const role = await tenant.$transaction(async (tx) => {
        const created = await tx.role.create({
          data: { name: dto.name, description: dto.description || null },
        });
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({
            roleId: created.id,
            permissionId,
          })),
        });
        const types = await tx.movementType.findMany({ select: { id: true } });
        await tx.roleMovementType.createMany({
          data: types.map((t) => ({
            roleId: created.id,
            movementTypeId: t.id,
          })),
        });
        return tx.role.findUniqueOrThrow({
          where: { id: created.id },
          include: roleInclude,
        });
      });
      return toDto(role);
    } catch (error) {
      if (isUniqueViolation(error)) throw roleErrors.nameTaken();
      throw error;
    }
  }

  async update(
    auth: AuthContext,
    id: number,
    dto: UpdateRoleDto,
  ): Promise<RoleDto> {
    const tenant = this.tenant(auth);
    const role = await this.findEditable(tenant, auth, id);

    if (dto.name !== undefined && dto.name !== role.name) {
      await this.assertNameFree(tenant, dto.name, id);
    }
    const permissionIds =
      dto.permissions === undefined
        ? undefined
        : await this.resolvePermissions(tenant, auth, dto.permissions);

    try {
      const updated = await tenant.$transaction(async (tx) => {
        await tx.role.update({
          where: { id },
          data: {
            ...(dto.name === undefined ? {} : { name: dto.name }),
            ...(dto.description === undefined
              ? {}
              : { description: dto.description || null }),
          },
        });
        if (permissionIds) {
          await tx.rolePermission.deleteMany({ where: { roleId: id } });
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({
              roleId: id,
              permissionId,
            })),
          });
        }
        return tx.role.findUniqueOrThrow({
          where: { id },
          include: roleInclude,
        });
      });
      return toDto(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw roleErrors.nameTaken();
      throw error;
    }
  }

  async remove(auth: AuthContext, id: number): Promise<void> {
    const tenant = this.tenant(auth);
    const role = await this.findEditable(tenant, auth, id);
    if (role._count.assignments > 0) throw roleErrors.inUse();
    const pending = await this.control.organizationInvitation.count({
      where: {
        organizationId: auth.organization.id,
        roleId: id,
        acceptedAt: null,
        revokedAt: null,
      },
    });
    if (pending > 0) throw roleErrors.inUse();
    await tenant.role.delete({ where: { id } });
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  private async findEditable(tenant: Tx, auth: AuthContext, id: number) {
    const role = await tenant.role.findUnique({
      where: { id },
      include: roleInclude,
    });
    if (!role) throw roleErrors.notFound();
    if (role.isSystem) throw roleErrors.systemLocked();
    if (
      !isOwner(auth.user.roles) &&
      auth.user.roles.some((held) => held.id === id)
    ) {
      throw roleErrors.ownRole();
    }
    return role;
  }

  /** Permission ids for the codes; non-owners only give what they hold. */
  private async resolvePermissions(
    tenant: Tx,
    auth: AuthContext,
    codes: string[],
  ): Promise<number[]> {
    const permissions = await tenant.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const found = new Set(permissions.map((p) => p.code));
    const unknown = codes.filter((code) => !found.has(code));
    if (unknown.length > 0) throw roleErrors.permissionNotFound(unknown);

    if (!isOwner(auth.user.roles)) {
      const held = grantedPermissions(auth.user.roles);
      if (!codes.every((code) => held.has(code))) {
        throw roleErrors.exceedsYourPermissions();
      }
    }
    return permissions.map((p) => p.id);
  }

  private async assertNameFree(tenant: Tx, name: string, exceptId?: number) {
    const existing = await tenant.role.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (existing) throw roleErrors.nameTaken();
  }
}
