import type { ExecutionContext, HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import type { AccessService } from './access.service.js';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';
import { AuthGuard } from './auth.guard.js';
import { PERMISSIONS_KEY } from './decorators.js';
import { SessionCookies } from './session-cookies.js';
import type { TokenService } from './token.service.js';

const context: AuthContext = {
  account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
  organization: {
    id: 10,
    subdomain: 'demo',
    legalName: 'Demo SAS',
    schemaName: 'tenant_demo',
  },
  user: {
    id: 5,
    jobTitle: null,
    roles: [
      {
        id: 2,
        name: 'Clerk',
        isSystem: false,
        warehouse: { id: 1, name: 'Main' },
        permissions: ['user.manage'],
      },
      {
        id: 3,
        name: 'Viewer',
        isSystem: false,
        warehouse: null,
        permissions: ['user.read'],
      },
    ],
  },
};

function setup(
  subdomain: string | null,
  permissions?: string[],
  request = {
    headers: { authorization: 'Bearer token' },
    cookies: {},
  } as unknown as AuthenticatedRequest,
) {
  const verifyAccessToken = vi
    .fn()
    .mockResolvedValue({ accountId: 1, organizationId: 10 });
  const execution = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) =>
    key === PERMISSIONS_KEY ? permissions : undefined,
  );
  const guard = new AuthGuard(
    reflector,
    { verifyAccessToken } as unknown as TokenService,
    {
      loadContext: vi.fn().mockResolvedValue(context),
    } as unknown as AccessService,
    { resolve: () => subdomain } as unknown as TenantResolver,
    new SessionCookies(
      { get: () => undefined } as unknown as ConfigService,
      {} as TokenService,
    ),
  );
  return { guard, execution, request, verifyAccessToken };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

describe('AuthGuard', () => {
  it('attaches the session when the token matches the subdomain', async () => {
    const { guard, execution, request } = setup('demo');
    await expect(guard.canActivate(execution)).resolves.toBe(true);
    expect(request.auth?.user.id).toBe(5);
  });

  it("prefers the organization's access cookie over a bearer header", async () => {
    const { guard, execution, verifyAccessToken } = setup('demo', undefined, {
      headers: { authorization: 'Bearer header-token' },
      cookies: { pango_access_demo: 'cookie-token', pango_access_x: 'other' },
    } as unknown as AuthenticatedRequest);
    await guard.canActivate(execution);
    expect(verifyAccessToken).toHaveBeenCalledWith('cookie-token');
  });

  it('rejects a request without any access token', async () => {
    const { guard, execution } = setup('demo', undefined, {
      headers: {},
      cookies: { pango_access_other: 'token' },
    } as unknown as AuthenticatedRequest);
    expect(await errorCode(guard.canActivate(execution))).toBe(
      'UNAUTHENTICATED',
    );
  });

  it('rejects a token issued for another organization', async () => {
    const { guard, execution } = setup('other');
    expect(await errorCode(guard.canActivate(execution))).toBe(
      'TENANT_MISMATCH',
    );
  });

  it('requires the request subdomain', async () => {
    const { guard, execution } = setup(null);
    expect(await errorCode(guard.canActivate(execution))).toBe(
      'TENANT_REQUIRED',
    );
  });

  it('counts permissions granted on any assignment', async () => {
    const scoped = setup('demo', ['user.manage']);
    await expect(scoped.guard.canActivate(scoped.execution)).resolves.toBe(
      true,
    );
    const denied = setup('demo', ['role.manage']);
    expect(await errorCode(denied.guard.canActivate(denied.execution))).toBe(
      'FORBIDDEN',
    );
  });
});
