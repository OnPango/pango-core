import type { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantResolver } from '../tenancy/tenant-resolver.service.js';
import type { AccessService } from './access.service.js';
import type { AuthContext, AuthenticatedRequest } from './auth-context.js';
import { AuthGuard } from './auth.guard.js';
import { PERMISSIONS_KEY } from './decorators.js';
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

function setup(subdomain: string | null, permissions?: string[]) {
  const request = {
    headers: { authorization: 'Bearer token' },
  } as AuthenticatedRequest;
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
    {
      verifyAccessToken: vi
        .fn()
        .mockResolvedValue({ accountId: 1, organizationId: 10 }),
    } as unknown as TokenService,
    {
      loadContext: vi.fn().mockResolvedValue(context),
    } as unknown as AccessService,
    { resolve: () => subdomain } as unknown as TenantResolver,
  );
  return { guard, execution, request };
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

  it('only counts permissions granted on every warehouse', async () => {
    const allowed = setup('demo', ['user.read']);
    await expect(allowed.guard.canActivate(allowed.execution)).resolves.toBe(
      true,
    );
    const denied = setup('demo', ['user.manage']);
    expect(await errorCode(denied.guard.canActivate(denied.execution))).toBe(
      'FORBIDDEN',
    );
  });
});
