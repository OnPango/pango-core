import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { positiveInt } from './token.service.js';

/** A device's trust, to set as the `pango_device_<subdomain>` cookie. */
export interface IssuedTrust {
  token: string;
  maxAgeMs: number;
  expiresAt: Date;
}

/** The account a trust belongs to: its password hash binds it to the current password. */
export interface TrustedAccount {
  id: number;
  passwordHash: string | null;
}

/** Hours of 0 or more: `0` turns the automatic trust off. */
function nonNegativeInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

/**
 * After the emailed code, the browser becomes a trusted device: for a while, logging in to the
 * same organization with the same account asks for the password only. Always for
 * `LOGIN_TRUSTED_DEVICE_HOURS` (default 12, so logging out by accident does not ask for another
 * code), or for `LOGIN_REMEMBER_DEVICE_DAYS` (default 30) when the user asks to be remembered.
 *
 * The trust is a token signed with `JWT_SECRET`: `<account>.<organization>.<expiry>.<signature>`.
 * Nothing is stored. The signature covers the account's password hash, so changing the password
 * ends every trust; rotating the secret ends them all.
 */
@Injectable()
export class TrustedDeviceService {
  /** Trust given after every code; 0: none unless the user asks to be remembered. */
  readonly defaultMs: number;
  /** Trust when the user asks to be remembered on this device. */
  readonly rememberMs: number;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.defaultMs =
      nonNegativeInt(config, 'LOGIN_TRUSTED_DEVICE_HOURS', 12) * 3_600_000;
    this.rememberMs =
      positiveInt(config, 'LOGIN_REMEMBER_DEVICE_DAYS', 30) * 86_400_000;
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  /** What the code step tells the user: how long each choice lasts. */
  get durations() {
    return {
      trustedDeviceHours: Math.round(this.defaultMs / 3_600_000),
      rememberDeviceDays: Math.round(this.rememberMs / 86_400_000),
    };
  }

  /** The trust a verified code grants; null when there is none to give. */
  issue(
    account: TrustedAccount,
    organizationId: number,
    remember: boolean,
    now = new Date(),
  ): IssuedTrust | null {
    const maxAgeMs = remember ? this.rememberMs : this.defaultMs;
    if (maxAgeMs <= 0) return null;
    const expires = Math.floor((now.getTime() + maxAgeMs) / 1000);
    const payload = `${account.id}.${organizationId}.${expires}`;
    return {
      token: `${payload}.${this.sign(payload, account.passwordHash)}`,
      maxAgeMs,
      expiresAt: new Date(expires * 1000),
    };
  }

  /** Whether `token` trusts this device for the account in the organization, now. */
  isTrusted(
    token: string | null,
    account: TrustedAccount,
    organizationId: number,
    now = new Date(),
  ): boolean {
    const parts = token?.split('.');
    if (!parts || parts.length !== 4) return false;
    const [accountId, orgId, expires, signature] = parts;
    if (Number(accountId) !== account.id || Number(orgId) !== organizationId)
      return false;
    if (!/^\d+$/.test(expires) || Number(expires) * 1000 <= now.getTime())
      return false;
    const expected = Buffer.from(
      this.sign(`${accountId}.${orgId}.${expires}`, account.passwordHash),
    );
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(payload: string, passwordHash: string | null): string {
    return createHmac('sha256', this.secret)
      .update(`trusted-device:${payload}:${passwordHash ?? ''}`)
      .digest('base64url');
  }
}
