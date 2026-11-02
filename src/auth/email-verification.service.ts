import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service.js';
import { emailVerificationEmail } from '../mail/templates.js';
import { WebLinks } from '../mail/web-links.service.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { authErrors } from './auth-errors.js';
import { generateOpaqueToken, hashToken } from './secrets.js';
import { positiveInt } from './token.service.js';

const PURPOSE = 'EMAIL_VERIFICATION';
// Minimum time between two verification emails to the same account.
const RESEND_COOLDOWN_MS = 60_000;

export interface VerificationTarget {
  account: { id: number; email: string; name: string };
  organization: { subdomain: string; legalName: string };
}

// Owners confirm their email before their first login. The emailed link opens the
// organization's frontend, which posts the token to POST /auth/verify-email.
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private readonly ttlMs: number;

  constructor(
    config: ConfigService,
    private readonly control: ControlPrismaService,
    private readonly mail: MailService,
    private readonly links: WebLinks,
  ) {
    this.ttlMs =
      positiveInt(config, 'EMAIL_VERIFICATION_TTL_HOURS', 24) * 3_600_000;
  }

  /** Issues a new link (older unused ones stop working) and emails it. Throws if the email fails. */
  async send({ account, organization }: VerificationTarget): Promise<void> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);
    await this.control.$transaction([
      this.control.accountToken.deleteMany({
        where: { accountId: account.id, purpose: PURPOSE, usedAt: null },
      }),
      this.control.accountToken.create({
        data: {
          accountId: account.id,
          purpose: PURPOSE,
          tokenHash: hashToken(token),
          expiresAt,
        },
      }),
    ]);
    await this.mail.send(
      emailVerificationEmail({
        to: account.email,
        name: account.name,
        organizationName: organization.legalName,
        verifyUrl: this.links.withToken(
          organization.subdomain,
          'verify-email',
          token,
        ),
        expiresAt,
      }),
    );
  }

  /** Like `send`, but never throws: a failed email can be requested again. */
  async trySend(target: VerificationTarget): Promise<boolean> {
    try {
      await this.send(target);
      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }

  /** Consumes the token and marks the account's email as verified. */
  async verify(token: string): Promise<{ email: string }> {
    const stored = await this.control.accountToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { account: true },
    });
    const now = new Date();
    if (
      !stored ||
      stored.purpose !== PURPOSE ||
      stored.usedAt ||
      stored.expiresAt <= now
    ) {
      throw authErrors.verificationTokenInvalid();
    }
    await this.control.$transaction(async (tx) => {
      const { count } = await tx.accountToken.updateMany({
        where: { id: stored.id, usedAt: null },
        data: { usedAt: now },
      });
      if (count === 0) throw authErrors.verificationTokenInvalid();
      await tx.account.updateMany({
        where: { id: stored.accountId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
    });
    return { email: stored.account.email };
  }

  /**
   * Sends a new link to an unverified account. Says nothing about whether the
   * email exists, and keeps a cooldown between emails.
   */
  async resend(email: string, subdomain: string | null): Promise<void> {
    const account = await this.control.account.findUnique({
      where: { email },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: { organization: true },
          orderBy: { createdAt: 'asc' },
        },
        tokens: {
          where: { purpose: PURPOSE },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!account || account.emailVerifiedAt || !account.isActive) return;
    const last = account.tokens[0];
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return;
    }
    // Link to the organization the request came from, or the account's first one.
    const membership =
      account.memberships.find((m) => m.organization.subdomain === subdomain) ??
      account.memberships[0];
    if (!membership) return;
    await this.trySend({
      account,
      organization: membership.organization,
    });
  }
}
