import type { HttpException } from '@nestjs/common';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { ProvisioningService } from '../tenancy/provisioning.service.js';
import type { AccessService } from './access.service.js';
import type { EmailVerificationService } from './email-verification.service.js';
import type { LoginCodeService } from './login-code.service.js';
import type { AuthContext } from './auth-context.js';
import { authErrors } from './auth-errors.js';
import { AuthService } from './auth.service.js';
import type { SignupDto } from './dto.js';
import { hashPassword, hashToken } from './secrets.js';
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
        id: 1,
        name: 'Owner',
        isSystem: true,
        warehouse: null,
        permissions: ['user.manage'],
      },
    ],
  },
};

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function setup({ loginCode = true } = {}) {
  const control = {
    account: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const access = {
    findActiveOrganization: vi.fn().mockResolvedValue({ id: 10 }),
    loadContext: vi.fn().mockResolvedValue(context),
  };
  const tokens = {
    accessTtlSeconds: 900,
    refreshTtlMs: 1000,
    signAccessToken: vi.fn().mockResolvedValue('access-token'),
  };
  const provisioning = {
    provision: vi.fn().mockResolvedValue({ accountId: 1, organizationId: 10 }),
  };
  const verification = { trySend: vi.fn().mockResolvedValue(true) };
  const loginCodes = {
    enabled: loginCode,
    start: vi.fn().mockResolvedValue({ token: 'challenge', state: {} }),
    verify: vi.fn().mockResolvedValue({ accountId: 1, organizationId: 10 }),
    resend: vi.fn(),
  };
  const service = new AuthService(
    control as unknown as ControlPrismaService,
    access as unknown as AccessService,
    tokens as unknown as TokenService,
    provisioning as unknown as ProvisioningService,
    verification as unknown as EmailVerificationService,
    loginCodes as unknown as LoginCodeService,
  );
  return { control, access, provisioning, verification, loginCodes, service };
}

describe('AuthService.login', () => {
  it('requires a subdomain', async () => {
    const { service } = setup();
    expect(
      await errorCode(service.login(null, { email: 'a@b.co', password: 'x' })),
    ).toBe('TENANT_REQUIRED');
  });

  it('rejects an unknown email and a wrong password the same way', async () => {
    const { service, control } = setup();
    control.account.findUnique.mockResolvedValueOnce(null);
    expect(
      await errorCode(
        service.login('demo', { email: 'nobody@b.co', password: 'secret123' }),
      ),
    ).toBe('INVALID_CREDENTIALS');

    control.account.findUnique.mockResolvedValueOnce({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: new Date(),
    });
    expect(
      await errorCode(
        service.login('demo', { email: 'ana@demo.co', password: 'wrong' }),
      ),
    ).toBe('INVALID_CREDENTIALS');
  });

  it('rejects valid credentials of a non-member', async () => {
    const { service, control, access } = setup();
    control.account.findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: new Date(),
    });
    access.loadContext.mockRejectedValue(authErrors.notAMember());
    expect(
      await errorCode(
        service.login('demo', {
          email: 'ana@demo.co',
          password: 'right-password',
        }),
      ),
    ).toBe('NOT_A_MEMBER');
    expect(control.refreshToken.create).not.toHaveBeenCalled();
  });

  it('emails a code instead of opening the session', async () => {
    const { service, control, access, loginCodes } = setup();
    control.account.findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: new Date(),
    });
    const result = await service.login('demo', {
      email: 'ana@demo.co',
      password: 'right-password',
    });
    expect(access.loadContext).toHaveBeenCalledWith(1, 10);
    expect(loginCodes.start).toHaveBeenCalledWith(context);
    expect(result).toEqual({ token: 'challenge', state: {} });
    expect(control.refreshToken.create).not.toHaveBeenCalled();
  });

  it('does not email a code to a non-member', async () => {
    const { service, control, access, loginCodes } = setup();
    control.account.findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: new Date(),
    });
    access.loadContext.mockRejectedValue(authErrors.notAMember());
    expect(
      await errorCode(
        service.login('demo', {
          email: 'ana@demo.co',
          password: 'right-password',
        }),
      ),
    ).toBe('NOT_A_MEMBER');
    expect(loginCodes.start).not.toHaveBeenCalled();
  });

  it('opens the session at once with the code disabled', async () => {
    const { service, control, access } = setup({ loginCode: false });
    control.account.findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: new Date(),
    });
    const session = await service.login('demo', {
      email: 'ana@demo.co',
      password: 'right-password',
    });
    if (!('accessToken' in session)) throw new Error('Expected a session');
    expect(access.loadContext).toHaveBeenCalledWith(1, 10);
    expect(session.accessToken).toBe('access-token');
    expect(session.user.roles[0].name).toBe('Owner');
    expect(session.organization).not.toHaveProperty('schemaName');
    const stored = control.refreshToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashToken(session.refreshToken));
  });
});

describe('AuthService.verifyLoginCode', () => {
  it('needs the pending login', async () => {
    const { service } = setup();
    expect(
      await errorCode(service.verifyLoginCode('demo', null, '123456')),
    ).toBe('LOGIN_CHALLENGE_INVALID');
  });

  it('opens the session of the verified challenge', async () => {
    const { service, loginCodes, access } = setup();
    const session = await service.verifyLoginCode(
      'demo',
      'challenge',
      '123456',
    );
    expect(loginCodes.verify).toHaveBeenCalledWith(
      'demo',
      'challenge',
      '123456',
    );
    expect(access.loadContext).toHaveBeenCalledWith(1, 10);
    expect(session.accessToken).toBe('access-token');
  });
});

describe('AuthService email verification', () => {
  const signup = {
    name: 'Ana',
    email: 'ana@demo.co',
    password: 'secret123',
    organization: {
      legalName: 'Demo SAS',
      subdomain: 'demo',
      country: 'CO',
      city: 'Bogotá',
      businessSector: 'RETAIL',
      teamSize: 'SIZE_1_5',
      productCount: 'COUNT_1_100',
    },
  } as SignupDto;

  it('blocks login until the email is confirmed', async () => {
    const { service, control } = setup();
    control.account.findUnique.mockResolvedValue({
      id: 1,
      passwordHash: await hashPassword('right-password'),
      emailVerifiedAt: null,
    });
    expect(
      await errorCode(
        service.login('demo', {
          email: 'ana@demo.co',
          password: 'right-password',
        }),
      ),
    ).toBe('EMAIL_NOT_VERIFIED');
    expect(control.refreshToken.create).not.toHaveBeenCalled();
  });

  it('sends a confirmation email and no session on a new sign-up', async () => {
    const { service, control, provisioning, verification } = setup();
    control.account.findUnique.mockResolvedValue(null);
    control.organization.findUnique.mockResolvedValue(null);
    const result = await service.signup(signup);
    expect(provisioning.provision.mock.calls[0][0]).toMatchObject({
      email: 'ana@demo.co',
      emailVerifiedAt: null,
    });
    expect(verification.trySend).toHaveBeenCalled();
    expect(result).toEqual({
      verificationRequired: true,
      email: 'ana@demo.co',
      organization: { subdomain: 'demo' },
      verificationEmailSent: true,
    });
    expect(control.refreshToken.create).not.toHaveBeenCalled();
  });

  it('logs in a verified account that creates another organization', async () => {
    const { service, control, verification } = setup();
    control.account.findUnique.mockResolvedValue({
      id: 1,
      name: 'Ana',
      isActive: true,
      passwordHash: await hashPassword('secret123'),
      emailVerifiedAt: new Date(),
    });
    control.organization.findUnique.mockResolvedValue(null);
    const result = await service.signup(signup);
    expect(result).toHaveProperty('accessToken');
    expect(verification.trySend).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh', () => {
  const stored = {
    id: 1,
    accountId: 1,
    organizationId: 10,
    revokedAt: null as Date | null,
    expiresAt: new Date(Date.now() + 60_000),
    organization: { subdomain: 'demo' },
  };

  it('rejects a token from another organization', async () => {
    const { service, control } = setup();
    control.refreshToken.findUnique.mockResolvedValue(stored);
    expect(await errorCode(service.refresh('other', 'token'))).toBe(
      'TENANT_MISMATCH',
    );
  });

  it('revokes every session when a rotated token is reused', async () => {
    const { service, control } = setup();
    control.refreshToken.findUnique.mockResolvedValue({
      ...stored,
      revokedAt: new Date(),
    });
    expect(await errorCode(service.refresh('demo', 'token'))).toBe(
      'INVALID_REFRESH_TOKEN',
    );
    expect(control.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 1, organizationId: 10, revokedAt: null },
      }),
    );
  });

  it('rotates a valid token', async () => {
    const { service, control } = setup();
    control.refreshToken.findUnique.mockResolvedValue(stored);
    const session = await service.refresh('demo', 'token');
    expect(control.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, revokedAt: null } }),
    );
    expect(session.refreshToken).not.toBe('token');
  });
});
