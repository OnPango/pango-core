import { Injectable } from '@nestjs/common';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import type { AuthContext, RoleGrant } from './auth-context.js';
import { authErrors } from './auth-errors.js';

// Access checks shared by login, refresh, invitations and AuthGuard. This is where
// tenant isolation is enforced: a tenant schema is only opened after an ACTIVE
// membership of the account in that organization is confirmed.
@Injectable()
export class AccessService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
  ) {}

  async findActiveOrganization(subdomain: string) {
    const organization = await this.control.organization.findUnique({
      where: { subdomain },
    });
    if (!organization) throw authErrors.organizationNotFound();
    if (organization.status !== 'ACTIVE') {
      throw authErrors.organizationInactive();
    }
    return organization;
  }

  /**
   * Loads the full session context of `accountId` in `organizationId`. Throws unless
   * the account, the organization, the membership and the tenant user are all active.
   */
  async loadContext(
    accountId: number,
    organizationId: number,
  ): Promise<AuthContext> {
    const membership = await this.control.organizationMember.findUnique({
      where: { accountId_organizationId: { accountId, organizationId } },
      include: { account: true, organization: true },
    });
    if (!membership) throw authErrors.notAMember();
    const { account, organization } = membership;
    if (!account.isActive) throw authErrors.accountDisabled();
    if (!account.emailVerifiedAt) throw authErrors.emailNotVerified();
    if (organization.status !== 'ACTIVE') {
      throw authErrors.organizationInactive();
    }
    if (membership.status === 'SUSPENDED') {
      throw authErrors.membershipSuspended();
    }
    if (membership.status !== 'ACTIVE') throw authErrors.notAMember();

    const user = await this.tenants
      .client(organization.schemaName)
      .user.findUnique({
        where: { accountId },
        include: {
          roleAssignments: {
            orderBy: { id: 'asc' },
            include: {
              warehouse: { select: { id: true, name: true } },
              role: {
                include: {
                  permissions: { include: { permission: true } },
                },
              },
            },
          },
        },
      });
    if (!user) throw authErrors.notAMember();
    if (!user.isActive) throw authErrors.userDisabled();

    const roles: RoleGrant[] = user.roleAssignments.map((assignment) => ({
      id: assignment.role.id,
      name: assignment.role.name,
      isSystem: assignment.role.isSystem,
      warehouse: assignment.warehouse,
      permissions: assignment.role.permissions
        .map((grant) => grant.permission.code)
        .sort(),
    }));

    return {
      account: { id: account.id, email: account.email, name: account.name },
      organization: {
        id: organization.id,
        subdomain: organization.subdomain,
        legalName: organization.legalName,
        schemaName: organization.schemaName,
      },
      user: { id: user.id, jobTitle: user.jobTitle, roles },
    };
  }
}
