import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service.js';
import { loginCodeEmail } from '../mail/templates.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { authErrors } from './auth-errors.js';
import {
  generateLoginCode,
  generateOpaqueToken,
  hashLoginCode,
  hashToken,
  sameDigest,
} from './secrets.js';
import { positiveInt } from './token.service.js';

export const LOGIN_CODE_LENGTH = 6;

/** What the client is told about a pending login; the token goes in a cookie. */
export interface LoginChallengeState {
  codeRequired: true;
  /** The address the code went to, masked: `a**@miempresa.co`. */
  email: string;
  codeLength: number;
  /** When the current code stops working. */
  expiresAt: Date;
  /** From when POST /auth/login/resend sends another code. */
  resendAvailableAt: Date;
  /** False if the email could not be sent; POST /auth/login/resend retries. */
  emailSent: boolean;
}

export interface StartedLoginChallenge {
  token: string;
  state: LoginChallengeState;
}

interface Recipient {
  account: { id: number; email: string; name: string };
  organization: { id: number; legalName: string };
}

/** `ana@miempresa.co` → `a**@miempresa.co`: enough to recognise it, not to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  return `${local[0]}${'*'.repeat(Math.min(Math.max(local.length - 1, 1), 3))}${email.slice(at)}`;
}

/**
 * Second step of the login: after the password, a six-digit code emailed to the account.
 * The challenge token travels in an HttpOnly cookie (`SessionCookies`), so the code alone,
 * typed on another browser, is useless.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);
  /** Off only where a password is enough (local development, scripts, e2e tests). */
  readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownMs: number;
  private readonly maxSends: number;
  private readonly secret: string;

  constructor(
    config: ConfigService,
    private readonly control: ControlPrismaService,
    private readonly mail: MailService,
  ) {
    this.enabled = config.get<string>('LOGIN_EMAIL_CODE_ENABLED') !== 'false';
    this.ttlMs = positiveInt(config, 'LOGIN_CODE_TTL_MINUTES', 10) * 60_000;
    this.maxAttempts = positiveInt(config, 'LOGIN_CODE_MAX_ATTEMPTS', 5);
    this.resendCooldownMs =
      positiveInt(config, 'LOGIN_CODE_RESEND_SECONDS', 60) * 1000;
    this.maxSends = positiveInt(config, 'LOGIN_CODE_MAX_SENDS', 5);
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  /** How long the challenge cookie lives: every code it may still send. */
  get cookieMaxAgeMs(): number {
    return this.ttlMs * this.maxSends;
  }

  /**
   * Opens a challenge and emails its code. Logging in again while a code sent within the
   * resend cooldown is pending reuses it (with a new token) instead of emailing another,
   * so repeating the password cannot flood the inbox. Older challenges stop working.
   */
  async start({
    account,
    organization,
  }: Recipient): Promise<StartedLoginChallenge> {
    const now = new Date();
    const token = generateOpaqueToken();
    const recent = await this.control.loginChallenge.findFirst({
      where: {
        accountId: account.id,
        organizationId: organization.id,
        consumedAt: null,
        expiresAt: { gt: now },
        lastSentAt: { gt: new Date(now.getTime() - this.resendCooldownMs) },
      },
      orderBy: { lastSentAt: 'desc' },
    });
    if (recent) {
      const reused = await this.control.loginChallenge.update({
        where: { id: recent.id },
        data: { tokenHash: hashToken(token) },
      });
      return { token, state: this.state(account.email, reused, true) };
    }

    const code = generateLoginCode();
    const challenge = await this.control.$transaction(async (tx) => {
      await tx.loginChallenge.updateMany({
        where: {
          accountId: account.id,
          organizationId: organization.id,
          consumedAt: null,
        },
        data: { consumedAt: now },
      });
      // The code's hash is bound to the challenge id, known once the row exists.
      const created = await tx.loginChallenge.create({
        data: {
          accountId: account.id,
          organizationId: organization.id,
          tokenHash: hashToken(token),
          codeHash: '0'.repeat(64),
          expiresAt: new Date(now.getTime() + this.ttlMs),
          lastSentAt: now,
        },
      });
      return tx.loginChallenge.update({
        where: { id: created.id },
        data: { codeHash: hashLoginCode(this.secret, created.id, code) },
      });
    });
    const emailSent = await this.trySend({ account, organization }, code);
    return { token, state: this.state(account.email, challenge, emailSent) };
  }

  /**
   * Checks the code of the challenge of `token`, opened in the organization of
   * `subdomain`, and consumes it. Wrong codes count; after the last attempt the challenge
   * ends and the user must log in again.
   */
  async verify(
    subdomain: string,
    token: string,
    code: string,
  ): Promise<{ accountId: number; organizationId: number }> {
    const challenge = await this.pending(subdomain, token);
    const now = new Date();
    if (challenge.expiresAt <= now) throw authErrors.loginCodeExpired();

    const expected = hashLoginCode(this.secret, challenge.id, code);
    if (!sameDigest(expected, challenge.codeHash)) {
      const { attempts } = await this.control.loginChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      if (attempts >= this.maxAttempts) {
        await this.control.loginChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null },
          data: { consumedAt: now },
        });
        throw authErrors.loginCodeAttemptsExceeded();
      }
      throw authErrors.loginCodeInvalid(this.maxAttempts - attempts);
    }

    // Guarded update: of two concurrent verifications, only one opens a session.
    const { count } = await this.control.loginChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (count === 0) throw authErrors.loginChallengeInvalid();
    return {
      accountId: challenge.accountId,
      organizationId: challenge.organizationId,
    };
  }

  /** Emails a new code for the challenge of `token`, after the cooldown and up to a limit. */
  async resend(subdomain: string, token: string): Promise<LoginChallengeState> {
    const challenge = await this.pending(subdomain, token);
    const now = new Date();
    const wait =
      challenge.lastSentAt.getTime() + this.resendCooldownMs - now.getTime();
    if (wait > 0)
      throw authErrors.loginCodeResendTooSoon(Math.ceil(wait / 1000));
    if (challenge.sendCount >= this.maxSends) {
      throw authErrors.loginCodeResendLimit();
    }

    const code = generateLoginCode();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    // Guarded on the last send, so two concurrent requests send one email.
    const { count } = await this.control.loginChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        lastSentAt: challenge.lastSentAt,
      },
      data: {
        codeHash: hashLoginCode(this.secret, challenge.id, code),
        attempts: 0,
        sendCount: { increment: 1 },
        expiresAt,
        lastSentAt: now,
      },
    });
    if (count === 0) {
      throw authErrors.loginCodeResendTooSoon(
        Math.ceil(this.resendCooldownMs / 1000),
      );
    }
    const emailSent = await this.trySend(
      { account: challenge.account, organization: challenge.organization },
      code,
    );
    return this.state(
      challenge.account.email,
      { expiresAt, lastSentAt: now },
      emailSent,
    );
  }

  /** The pending challenge of `token` in the organization of `subdomain`. */
  private async pending(subdomain: string, token: string) {
    const challenge = await this.control.loginChallenge.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        account: { select: { id: true, email: true, name: true } },
        organization: {
          select: { id: true, subdomain: true, legalName: true },
        },
      },
    });
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.organization.subdomain !== subdomain
    ) {
      throw authErrors.loginChallengeInvalid();
    }
    return challenge;
  }

  private state(
    email: string,
    challenge: { expiresAt: Date; lastSentAt: Date },
    emailSent: boolean,
  ): LoginChallengeState {
    return {
      codeRequired: true,
      email: maskEmail(email),
      codeLength: LOGIN_CODE_LENGTH,
      expiresAt: challenge.expiresAt,
      resendAvailableAt: new Date(
        challenge.lastSentAt.getTime() + this.resendCooldownMs,
      ),
      emailSent,
    };
  }

  /** Never throws: a failed email can be requested again with resend. */
  private async trySend(
    { account, organization }: Recipient,
    code: string,
  ): Promise<boolean> {
    try {
      await this.mail.send(
        loginCodeEmail({
          to: account.email,
          name: account.name,
          organizationName: organization.legalName,
          code,
          expiresInMinutes: Math.round(this.ttlMs / 60_000),
        }),
      );
      return true;
    } catch (error) {
      this.logger.error(error);
      return false;
    }
  }
}
