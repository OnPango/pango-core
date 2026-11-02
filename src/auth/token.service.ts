import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'pango-core';
const AUDIENCE = 'pango';

export interface AccessClaims {
  accountId: number;
  /** The organization the session was opened in. */
  organizationId: number;
}

export function positiveInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

// Short-lived access tokens (HS256 JWT). Refresh tokens are opaque and live in the
// database (see AuthService).
@Injectable()
export class TokenService {
  readonly accessTtlSeconds: number;
  readonly refreshTtlMs: number;
  private readonly secret: Uint8Array;

  constructor(config: ConfigService) {
    const secret = config.getOrThrow<string>('JWT_SECRET');
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }
    this.secret = new TextEncoder().encode(secret);
    this.accessTtlSeconds = positiveInt(config, 'JWT_ACCESS_TTL_SECONDS', 900);
    this.refreshTtlMs =
      positiveInt(config, 'REFRESH_TOKEN_TTL_DAYS', 30) * 24 * 60 * 60 * 1000;
  }

  signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ org: claims.organizationId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(claims.accountId))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTtlSeconds}s`)
      .sign(this.secret);
  }

  /** Throws if the token is invalid, expired or malformed. */
  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const accountId = Number(payload.sub);
    const organizationId = payload.org;
    if (
      !Number.isInteger(accountId) ||
      typeof organizationId !== 'number' ||
      !Number.isInteger(organizationId)
    ) {
      throw new Error('Malformed access token');
    }
    return { accountId, organizationId };
  }
}
