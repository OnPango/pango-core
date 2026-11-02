import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthContext } from '../auth/auth-context.js';
import { apiError, authErrors } from '../auth/auth-errors.js';
import { AuthService, type SessionResponse } from '../auth/auth.service.js';
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../auth/secrets.js';
import { positiveInt } from '../auth/token.service.js';
import { MailService } from '../mail/mail.service.js';
import { WebLinks } from '../mail/web-links.service.js';
import { invitationEmail } from '../mail/templates.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import type { AcceptInvitationDto, CreateInvitationDto } from './dto.js';
import type {
  InvitationDto,
  InvitationPreviewDto,
  PendingInvitationDto,
} from './responses.js';

const invitationErrors = {
  invalid: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'INVITATION_INVALID',
      'This invitation is invalid, was already used or has expired',
    ),
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'INVITATION_NOT_FOUND',
      'Invitation not found',
    ),
  roleNotFound: () =>
    apiError(HttpStatus.BAD_REQUEST, 'ROLE_NOT_FOUND', 'Role not found'),
  warehouseNotFound: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found or inactive',
    ),
  alreadyMember: () =>
    apiError(
      HttpStatus.CONFLICT,
      'ALREADY_MEMBER',
      'This email already belongs to an active member of the organization',
    ),
  nameRequired: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'NAME_REQUIRED',
      'name is required to create a new account',
    ),
  mailFailed: () =>
    apiError(
      HttpStatus.BAD_GATEWAY,
      'MAIL_DELIVERY_FAILED',
      'The invitation email could not be sent; try again',
    ),
};

// Employees join only through invitations: an authorized member invites an email,
// the invitee follows the emailed link to the organization's subdomain and sets a
// password (or proves the one of their existing account).
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly ttlMs: number;

  constructor(
    config: ConfigService,
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    private readonly links: WebLinks,
  ) {
    this.ttlMs = positiveInt(config, 'INVITATION_TTL_HOURS', 72) * 3_600_000;
  }

  async create(
    auth: AuthContext,
    dto: CreateInvitationDto,
  ): Promise<InvitationDto> {
    const { organization } = auth;
    const tenant = this.tenants.client(organization.schemaName);

    const role = await tenant.role.findUnique({ where: { id: dto.roleId } });
    if (!role) throw invitationErrors.roleNotFound();
    // System roles (Owner) can only be granted by someone holding one on every warehouse.
    if (
      role.isSystem &&
      !auth.user.roles.some((r) => r.isSystem && r.warehouse === null)
    ) {
      throw authErrors.forbidden();
    }
    if (dto.warehouseId !== undefined) {
      const warehouse = await tenant.warehouse.findUnique({
        where: { id: dto.warehouseId },
      });
      if (!warehouse?.isActive) throw invitationErrors.warehouseNotFound();
    }

    const member = await this.control.organizationMember.findFirst({
      where: {
        organizationId: organization.id,
        status: 'ACTIVE',
        account: { email: dto.email },
      },
    });
    if (member) throw invitationErrors.alreadyMember();

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    // A new invitation replaces any pending one for the same email.
    const [, invitation] = await this.control.$transaction([
      this.control.organizationInvitation.updateMany({
        where: {
          organizationId: organization.id,
          email: dto.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
      this.control.organizationInvitation.create({
        data: {
          organizationId: organization.id,
          email: dto.email,
          roleId: role.id,
          warehouseId: dto.warehouseId ?? null,
          invitedByAccountId: auth.account.id,
          tokenHash: hashToken(token),
          expiresAt,
        },
      }),
    ]);

    try {
      await this.mail.send(
        invitationEmail({
          to: dto.email,
          organizationName: organization.legalName,
          inviterName: auth.account.name,
          roleName: role.name,
          acceptUrl: this.links.withToken(
            organization.subdomain,
            'invitations/accept',
            token,
          ),
          expiresAt,
        }),
      );
    } catch (error) {
      this.logger.error(error);
      await this.control.organizationInvitation.update({
        where: { id: invitation.id },
        data: { revokedAt: new Date() },
      });
      throw invitationErrors.mailFailed();
    }

    return {
      id: invitation.id,
      email: invitation.email,
      role: { id: role.id, name: role.name },
      warehouseId: invitation.warehouseId,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  /** Pending (not accepted, not revoked) invitations, including expired ones. */
  async listPending(auth: AuthContext): Promise<PendingInvitationDto[]> {
    const invitations = await this.control.organizationInvitation.findMany({
      where: {
        organizationId: auth.organization.id,
        acceptedAt: null,
        revokedAt: null,
      },
      include: { invitedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const roles = await this.tenants
      .client(auth.organization.schemaName)
      .role.findMany({
        where: { id: { in: [...new Set(invitations.map((i) => i.roleId))] } },
        select: { id: true, name: true },
      });
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const now = new Date();
    return invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: {
        id: invitation.roleId,
        name: roleNames.get(invitation.roleId) ?? null,
      },
      warehouseId: invitation.warehouseId,
      invitedBy: invitation.invitedBy,
      expiresAt: invitation.expiresAt,
      expired: invitation.expiresAt <= now,
      createdAt: invitation.createdAt,
    }));
  }

  async revoke(auth: AuthContext, id: number): Promise<void> {
    const { count } = await this.control.organizationInvitation.updateMany({
      where: {
        id,
        organizationId: auth.organization.id,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw invitationErrors.notFound();
  }

  /** What the accept page shows before the invitee submits the form. */
  async preview(token: string): Promise<InvitationPreviewDto> {
    const invitation = await this.findUsable(token);
    const account = await this.control.account.findUnique({
      where: { email: invitation.email },
      select: { passwordHash: true },
    });
    return {
      email: invitation.email,
      organization: {
        subdomain: invitation.organization.subdomain,
        legalName: invitation.organization.legalName,
      },
      invitedBy: invitation.invitedBy.name,
      expiresAt: invitation.expiresAt,
      /** False: the form must ask for `name` and a new password. */
      hasAccount: Boolean(account?.passwordHash),
    };
  }

  /**
   * Accepts an invitation on the organization's subdomain and logs the invitee in.
   * Steps are ordered so a failure can be retried: account, then tenant user
   * (idempotent), then the invitation claim and membership in one transaction.
   */
  async accept(
    subdomain: string | null,
    dto: AcceptInvitationDto,
  ): Promise<SessionResponse> {
    if (!subdomain) throw authErrors.tenantRequired();
    const invitation = await this.findUsable(dto.token);
    const { organization } = invitation;
    if (organization.subdomain !== subdomain) {
      throw authErrors.tenantMismatch();
    }

    // 1. Account: reuse it (proving its password) or create it.
    let account = await this.control.account.findUnique({
      where: { email: invitation.email },
    });
    // The emailed token proves ownership of the address, so the email is verified.
    const verifiedAt = account?.emailVerifiedAt ?? new Date();
    if (account?.passwordHash) {
      if (!(await verifyPassword(account.passwordHash, dto.password))) {
        throw authErrors.invalidCredentials();
      }
      if (!account.emailVerifiedAt) {
        account = await this.control.account.update({
          where: { id: account.id },
          data: { emailVerifiedAt: verifiedAt },
        });
      }
    } else if (account) {
      // Account without a password (created by the CLI): the emailed token proves
      // ownership of the address, so the password is set now.
      account = await this.control.account.update({
        where: { id: account.id },
        data: {
          passwordHash: await hashPassword(dto.password),
          name: dto.name ?? account.name,
          emailVerifiedAt: verifiedAt,
        },
      });
    } else {
      if (!dto.name) throw invitationErrors.nameRequired();
      account = await this.control.account.create({
        data: {
          email: invitation.email,
          name: dto.name,
          passwordHash: await hashPassword(dto.password),
          emailVerifiedAt: verifiedAt,
        },
      });
    }
    if (!account.isActive) throw authErrors.accountDisabled();
    const accountId = account.id;

    // 2. Tenant user with the invited role.
    const tenant = this.tenants.client(organization.schemaName);
    await tenant.$transaction(async (tx) => {
      const role = await tx.role.findUnique({
        where: { id: invitation.roleId },
      });
      if (!role) throw invitationErrors.invalid();
      const user = await tx.user.upsert({
        where: { accountId },
        create: { accountId },
        update: { isActive: true },
      });
      const assigned = await tx.roleAssignment.findFirst({
        where: {
          userId: user.id,
          roleId: invitation.roleId,
          warehouseId: invitation.warehouseId,
        },
      });
      if (!assigned) {
        await tx.roleAssignment.create({
          data: {
            userId: user.id,
            roleId: invitation.roleId,
            warehouseId: invitation.warehouseId,
          },
        });
      }
    });

    // 3. Claim the invitation and activate the membership.
    await this.control.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now },
      });
      if (count === 0) throw invitationErrors.invalid();
      await tx.organizationMember.upsert({
        where: {
          accountId_organizationId: {
            accountId,
            organizationId: organization.id,
          },
        },
        create: {
          accountId,
          organizationId: organization.id,
          status: 'ACTIVE',
          joinedAt: now,
        },
        update: { status: 'ACTIVE', joinedAt: now },
      });
    });

    return this.auth.createSession(accountId, organization.id);
  }

  private async findUsable(token: string) {
    const invitation = await this.control.organizationInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        organization: true,
        invitedBy: { select: { name: true } },
      },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date() ||
      invitation.organization.status !== 'ACTIVE'
    ) {
      throw invitationErrors.invalid();
    }
    return invitation;
  }
}
