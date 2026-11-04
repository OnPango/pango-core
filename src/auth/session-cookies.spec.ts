import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { SessionResponse } from './auth.service.js';
import { SessionCookies } from './session-cookies.js';
import type { TokenService } from './token.service.js';

function setup(env: Record<string, string> = {}) {
  const config = { get: (key: string) => env[key] } as ConfigService;
  const tokens = { refreshTtlMs: 1000 } as TokenService;
  const response = { cookie: vi.fn(), clearCookie: vi.fn() };
  return {
    cookies: new SessionCookies(config, tokens),
    response,
    res: response as unknown as Response,
  };
}

const session = {
  tokenType: 'Bearer',
  accessToken: 'access',
  expiresIn: 900,
  refreshToken: 'refresh-secret',
  refreshTokenExpiresAt: new Date(),
  account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
  organization: { id: 10, subdomain: 'demo', legalName: 'Demo SAS' },
  user: { id: 5, jobTitle: null, roles: [] },
} satisfies SessionResponse;

describe('SessionCookies', () => {
  it('moves the refresh token into an HttpOnly cookie per organization', () => {
    const { cookies, response, res } = setup();
    const body = cookies.issue(res, session);
    expect(body).not.toHaveProperty('refreshToken');
    expect(body.accessToken).toBe('access');
    expect(response.cookie).toHaveBeenCalledWith(
      'pango_refresh_demo',
      'refresh-secret',
      {
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: '/auth',
        maxAge: 1000,
      },
    );
  });

  it('is Secure in production unless overridden', () => {
    const prod = setup({ NODE_ENV: 'production' });
    prod.cookies.issue(prod.res, session);
    expect(prod.response.cookie.mock.calls[0][2].secure).toBe(true);

    const forced = setup({ REFRESH_COOKIE_SECURE: 'true' });
    forced.cookies.issue(forced.res, session);
    expect(forced.response.cookie.mock.calls[0][2].secure).toBe(true);
  });

  it("reads only the request organization's cookie", () => {
    const { cookies } = setup();
    const request = {
      cookies: { pango_refresh_demo: 'a', pango_refresh_other: 'b' },
    } as unknown as Request;
    expect(cookies.read(request, 'demo')).toBe('a');
    expect(cookies.read(request, 'missing')).toBeNull();
    expect(cookies.read({} as Request, 'demo')).toBeNull();
  });
});
