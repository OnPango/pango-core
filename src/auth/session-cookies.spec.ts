import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { SessionResponse } from './auth.service.js';
import { hasSessionCookie, SessionCookies } from './session-cookies.js';
import type { TokenService } from './token.service.js';

function setup(env: Record<string, string> = {}) {
  const config = { get: (key: string) => env[key] } as ConfigService;
  const tokens = { accessTtlSeconds: 900, refreshTtlMs: 1000 } as TokenService;
  const response = { cookie: vi.fn(), clearCookie: vi.fn() };
  return {
    cookies: new SessionCookies(config, tokens),
    response,
    res: response as unknown as Response,
  };
}

const session = {
  tokenType: 'Bearer',
  accessToken: 'access-secret',
  expiresIn: 900,
  refreshToken: 'refresh-secret',
  refreshTokenExpiresAt: new Date(),
  account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
  organization: { id: 10, subdomain: 'demo', legalName: 'Demo SAS' },
  user: { id: 5, jobTitle: null, roles: [] },
} satisfies SessionResponse;

describe('SessionCookies', () => {
  it('moves both tokens into HttpOnly cookies per organization', () => {
    const { cookies, response, res } = setup({
      COOKIE_SECURE: 'true',
      COOKIE_DOMAIN: '.onpango.com',
    });
    const body = cookies.issue(res, session);
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    expect(body).not.toHaveProperty('tokenType');
    const flags = {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: '.onpango.com',
    };
    expect(response.cookie).toHaveBeenCalledWith(
      'pango_access_demo',
      'access-secret',
      { ...flags, path: '/', maxAge: 900_000 },
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'pango_refresh_demo',
      'refresh-secret',
      { ...flags, path: '/auth', maxAge: 1000 },
    );
  });

  it('is Secure by default only in production, and host-only without COOKIE_DOMAIN', () => {
    const dev = setup();
    dev.cookies.issue(dev.res, session);
    expect(dev.response.cookie.mock.calls[0][2]).not.toHaveProperty('domain');
    expect(dev.response.cookie.mock.calls[0][2].secure).toBe(false);

    const prod = setup({ NODE_ENV: 'production' });
    prod.cookies.issue(prod.res, session);
    expect(prod.response.cookie.mock.calls[0][2].secure).toBe(true);
  });

  it("reads only the request organization's cookies", () => {
    const { cookies } = setup();
    const request = {
      cookies: {
        pango_access_demo: 'a',
        pango_refresh_demo: 'r',
        pango_access_other: 'b',
      },
    } as unknown as Request;
    expect(cookies.readAccess(request, 'demo')).toBe('a');
    expect(cookies.readRefresh(request, 'demo')).toBe('r');
    expect(cookies.readAccess(request, 'missing')).toBeNull();
    expect(hasSessionCookie(request)).toBe(true);
    expect(
      hasSessionCookie({ cookies: { other: 'x' } } as unknown as Request),
    ).toBe(false);
  });

  it('clears both cookies', () => {
    const { cookies, response, res } = setup();
    cookies.clear(res, 'demo');
    expect(response.clearCookie.mock.calls.map((c) => c[0])).toEqual([
      'pango_access_demo',
      'pango_refresh_demo',
    ]);
  });
});
