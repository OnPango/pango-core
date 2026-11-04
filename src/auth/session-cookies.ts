import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { SessionResponse } from './auth.service.js';
import { TokenService } from './token.service.js';

export const REFRESH_COOKIE_PREFIX = 'pango_refresh_';
// Only the endpoints that read it (refresh, logout) receive the cookie.
export const REFRESH_COOKIE_PATH = '/auth';

/** What a session endpoint returns: the refresh token travels only in the cookie. */
export type SessionBody = Omit<SessionResponse, 'refreshToken'>;

/**
 * Refresh tokens live in an HttpOnly cookie so frontend JavaScript (and an XSS)
 * cannot read them. One cookie per organization: when the API is served from a
 * shared host (api.onpango.com), sessions in two organizations must not overwrite
 * each other.
 */
@Injectable()
export class SessionCookies {
  private readonly secure: boolean;

  constructor(
    config: ConfigService,
    private readonly tokens: TokenService,
  ) {
    const flag = config.get<string>('REFRESH_COOKIE_SECURE');
    this.secure =
      flag === undefined || flag === ''
        ? config.get<string>('NODE_ENV') === 'production'
        : flag === 'true';
  }

  static cookieName(subdomain: string): string {
    return `${REFRESH_COOKIE_PREFIX}${subdomain}`;
  }

  /** Sets the refresh cookie and returns the body without the refresh token. */
  issue(response: Response, session: SessionResponse): SessionBody {
    const { refreshToken, ...body } = session;
    response.cookie(
      SessionCookies.cookieName(session.organization.subdomain),
      refreshToken,
      { ...this.options(), maxAge: this.tokens.refreshTtlMs },
    );
    return body;
  }

  read(request: Request, subdomain: string): string | null {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[SessionCookies.cookieName(subdomain)];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  clear(response: Response, subdomain: string): void {
    response.clearCookie(SessionCookies.cookieName(subdomain), this.options());
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    };
  }
}
