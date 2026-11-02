import { Injectable } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { OwnerAccount } from '../tenancy/provision-organization.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { isValidSubdomain } from '../tenancy/subdomain.js';
import { AccessService } from './access.service.js';
import { type SessionProfile, toSessionProfile } from './auth-context.js';
import { authErrors } from './auth-errors.js';
import type { LoginDto, SignupDto } from './dto.js';
import { EmailVerificationService } from './email-verification.service.js';
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './secrets.js';
import { TokenService } from './token.service.js';

export interface SessionResponse extends SessionProfile {
  tokenType: 'Bearer';
  accessToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/** Sign-up of a new (unverified) account: no session until the email is confirmed. */
export interface VerificationRequiredResponse {
  verificationRequired: true;
  email: string;
  organization: { subdomain: string };
  /** False if the email could not be sent; POST /auth/verify-email/resend retries. */
  verificationEmailSent: boolean;
}

// Unique violations raised while provisioning, mapped to API errors.
function provisioningConflict(error: unknown) {
  if (!(error instanceof DatabaseError)) return null;
  if (error.code === '42P06') return authErrors.subdomainTaken(); // duplicate_schema
  if (error.code !== '23505') return null; // unique_violation
  switch (error.constraint) {
    case 'accounts_email_key':
      return authErrors.emailTaken();
    case 'organizations_subdomain_key':
    case 'organizations_schema_name_key':
      return authErrors.subdomainTaken();
    case 'organizations_tax_id_key':
      return authErrors.taxIdTaken();
    default:
      return null;
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly access: AccessService,
    private readonly tokens: TokenService,
    private readonly provisioning: ProvisioningService,
    private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Owner sign-up, the only open registration: creates the organization with its
   * tenant schema. A new account must confirm its email before logging in, so it
   * gets a confirmation email instead of a session. An existing account can create
   * another organization by proving its password; if already verified, it is logged in.
   */
  async signup(
    dto: SignupDto,
  ): Promise<SessionResponse | VerificationRequiredResponse> {
    const { organization } = dto;
    if (!isValidSubdomain(organization.subdomain)) {
      throw authErrors.subdomainInvalid();
    }

    const existing = await this.control.account.findUnique({
      where: { email: dto.email },
    });
    let owner: OwnerAccount;
    if (existing) {
      if (!(await verifyPassword(existing.passwordHash, dto.password))) {
        throw authErrors.emailTaken();
      }
      if (!existing.isActive) throw authErrors.accountDisabled();
      owner = { id: existing.id };
    } else {
      owner = {
        email: dto.email,
        name: dto.name,
        passwordHash: await hashPassword(dto.password),
        emailVerifiedAt: null,
      };
    }

    if (
      await this.control.organization.findUnique({
        where: { subdomain: organization.subdomain },
      })
    ) {
      throw authErrors.subdomainTaken();
    }
    if (
      organization.taxId &&
      (await this.control.organization.findUnique({
        where: { taxId: organization.taxId },
      }))
    ) {
      throw authErrors.taxIdTaken();
    }

    let accountId: number;
    let organizationId: number;
    try {
      ({ accountId, organizationId } = await this.provisioning.provision(
        owner,
        organization,
      ));
    } catch (error) {
      throw provisioningConflict(error) ?? error;
    }

    if (existing?.emailVerifiedAt) {
      return this.createSession(accountId, organizationId);
    }
    const verificationEmailSent = await this.verification.trySend({
      account: {
        id: accountId,
        email: dto.email,
        name: existing?.name ?? dto.name,
      },
      organization,
    });
    return {
      verificationRequired: true,
      email: dto.email,
      organization: { subdomain: organization.subdomain },
      verificationEmailSent,
    };
  }

  /**
   * Logs in to the organization of `subdomain`. Valid credentials of an account
   * that is not a member of that organization are rejected with NOT_A_MEMBER.
   */
  async login(subdomain: string | null, dto: LoginDto) {
    if (!subdomain) throw authErrors.tenantRequired();
    const organization = await this.access.findActiveOrganization(subdomain);
    const account = await this.control.account.findUnique({
      where: { email: dto.email },
    });
    const valid = await verifyPassword(account?.passwordHash, dto.password);
    if (!account || !valid) throw authErrors.invalidCredentials();
    if (!account.emailVerifiedAt) throw authErrors.emailNotVerified();
    return this.createSession(account.id, organization.id);
  }

  /**
   * Rotates a refresh token. Presenting a token that was already rotated or revoked
   * is treated as theft: every session of that account in the organization ends.
   */
  async refresh(subdomain: string | null, refreshToken: string) {
    if (!subdomain) throw authErrors.tenantRequired();
    const stored = await this.control.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { organization: { select: { subdomain: true } } },
    });
    if (!stored) throw authErrors.invalidRefreshToken();
    if (stored.organization.subdomain !== subdomain) {
      throw authErrors.tenantMismatch();
    }

    const now = new Date();
    if (stored.revokedAt) {
      await this.control.refreshToken.updateMany({
        where: {
          accountId: stored.accountId,
          organizationId: stored.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      throw authErrors.invalidRefreshToken();
    }
    if (stored.expiresAt <= now) throw authErrors.invalidRefreshToken();

    // Guarded update: of two concurrent refreshes with the same token, only one wins.
    const { count } = await this.control.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (count === 0) throw authErrors.invalidRefreshToken();

    return this.createSession(stored.accountId, stored.organizationId);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.control.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Verifies access to the organization and issues an access + refresh token pair. */
  async createSession(
    accountId: number,
    organizationId: number,
  ): Promise<SessionResponse> {
    const context = await this.access.loadContext(accountId, organizationId);

    const refreshToken = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(
      Date.now() + this.tokens.refreshTtlMs,
    );
    await this.control.refreshToken.create({
      data: {
        accountId,
        organizationId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
      },
    });

    return {
      tokenType: 'Bearer',
      accessToken: await this.tokens.signAccessToken({
        accountId,
        organizationId,
      }),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt,
      ...toSessionProfile(context),
    };
  }
}
