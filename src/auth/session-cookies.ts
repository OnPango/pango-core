import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { SessionResponse } from './auth.service.js';
import { TokenService } from './token.service.js';

export const SESSION_COOKIE_PREFIX = 'pango_';
export const ACCESS_COOKIE_PREFIX = `${SESSION_COOKIE_PREFIX}access_`;
export const REFRESH_COOKIE_PREFIX = `${SESSION_COOKIE_PREFIX}refresh_`;
// Only the endpoints that read it (refresh, logout) receive the refresh cookie.
export const REFRESH_COOKIE_PATH = '/auth';
// The pending login (second step) is only read by /auth/login/verify and /resend.
export const LOGIN_COOKIE_PREFIX = `${SESSION_COOKIE_PREFIX}login_`;
export const LOGIN_COOKIE_PATH = '/auth/login';

/** What a session endpoint returns: both tokens travel only in cookies. */
export type SessionBody = Omit<
  SessionResponse,
  'tokenType' | 'accessToken' | 'refreshToken'
>;

/**
 * Session tokens live in HttpOnly cookies, so frontend JavaScript (and an XSS)
 * never sees them. One pair per organization (`<prefix><subdomain>`): with
 * Domain=.onpango.com every subdomain receives every cookie, and sessions in two
 * organizations must not overwrite each other. CSRF is covered by SameSite=Lax
 * plus CsrfGuard (Origin check on unsafe methods).
 */
@Injectable()
export class SessionCookies {
  private readonly base: CookieOptions;

  constructor(
    config: ConfigService,
    private readonly tokens: TokenService,
  ) {
    const secure = config.get<string>('COOKIE_SECURE');
    const domain = config.get<string>('COOKIE_DOMAIN');
    this.base = {
      httpOnly: true,
      secure:
        secure === undefined || secure === ''
          ? config.get<string>('NODE_ENV') === 'production'
          : secure === 'true',
      sameSite: 'lax',
      ...(domain ? { domain } : {}),
    };
  }

  static accessName(subdomain: string): string {
    return `${ACCESS_COOKIE_PREFIX}${subdomain}`;
  }

  static refreshName(subdomain: string): string {
    return `${REFRESH_COOKIE_PREFIX}${subdomain}`;
  }

  static loginName(subdomain: string): string {
    return `${LOGIN_COOKIE_PREFIX}${subdomain}`;
  }

  /** Holds the token of a pending login until its code is entered. */
  issueLoginChallenge(
    response: Response,
    subdomain: string,
    token: string,
    maxAgeMs: number,
  ): void {
    response.cookie(SessionCookies.loginName(subdomain), token, {
      ...this.loginOptions(),
      maxAge: maxAgeMs,
    });
  }

  readLoginChallenge(request: Request, subdomain: string): string | null {
    return readCookie(request, SessionCookies.loginName(subdomain));
  }

  clearLoginChallenge(response: Response, subdomain: string): void {
    response.clearCookie(
      SessionCookies.loginName(subdomain),
      this.loginOptions(),
    );
  }

  /** Sets both cookies and returns the body without any token. */
  issue(response: Response, session: SessionResponse): SessionBody {
    const {
      tokenType: _tokenType,
      accessToken,
      refreshToken,
      ...body
    } = session;
    const { subdomain } = session.organization;
    response.cookie(SessionCookies.accessName(subdomain), accessToken, {
      ...this.accessOptions(),
      maxAge: this.tokens.accessTtlSeconds * 1000,
    });
    response.cookie(SessionCookies.refreshName(subdomain), refreshToken, {
      ...this.refreshOptions(),
      maxAge: this.tokens.refreshTtlMs,
    });
    return body;
  }

  readAccess(request: Request, subdomain: string): string | null {
    return readCookie(request, SessionCookies.accessName(subdomain));
  }

  readRefresh(request: Request, subdomain: string): string | null {
    return readCookie(request, SessionCookies.refreshName(subdomain));
  }

  clear(response: Response, subdomain: string): void {
    response.clearCookie(
      SessionCookies.accessName(subdomain),
      this.accessOptions(),
    );
    response.clearCookie(
      SessionCookies.refreshName(subdomain),
      this.refreshOptions(),
    );
  }

  private accessOptions(): CookieOptions {
    return { ...this.base, path: '/' };
  }

  private refreshOptions(): CookieOptions {
    return { ...this.base, path: REFRESH_COOKIE_PATH };
  }

  private loginOptions(): CookieOptions {
    return { ...this.base, path: LOGIN_COOKIE_PATH };
  }
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** True when the request carries any session cookie. */
export function hasSessionCookie(request: Request): boolean {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  return Object.keys(cookies ?? {}).some((name) =>
    name.startsWith(SESSION_COOKIE_PREFIX),
  );
}
