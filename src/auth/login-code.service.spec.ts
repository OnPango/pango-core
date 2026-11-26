import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MailMessage, MailService } from '../mail/mail.service.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { LoginCodeService, maskEmail } from './login-code.service.js';
import type { TrustedDeviceService } from './trusted-device.service.js';

// Predictable codes, so a resent code always differs from the previous one.
let nextCode = 100_000;
vi.mock('./secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./secrets.js')>()),
  generateLoginCode: () => String(++nextCode),
}));

interface Row {
  id: number;
  accountId: number;
  organizationId: number;
  tokenHash: string;
  codeHash: string;
  attempts: number;
  sendCount: number;
  expiresAt: Date;
  lastSentAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

type Where = Record<string, unknown>;

// Only the filters LoginCodeService uses: equality, null and `gt`.
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key as keyof Row];
    if (condition === null) return value === null;
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (typeof condition === 'object' && condition && 'gt' in condition) {
      return (value as Date) > (condition as { gt: Date }).gt;
    }
    return value === condition;
  });
}

function apply(row: Row, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    const current = row[key as keyof Row] as number;
    (row as unknown as Record<string, unknown>)[key] =
      typeof value === 'object' && value && 'increment' in value
        ? current + (value as { increment: number }).increment
        : value;
  }
}

function fakeControl() {
  const rows: Row[] = [];
  const account = { id: 1, email: 'ana@demo.co', name: 'Ana' };
  const organization = { id: 10, subdomain: 'demo', legalName: 'Demo SAS' };
  const loginChallenge = {
    findFirst: async ({ where }: { where: Where }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((a, b) => b.lastSentAt.getTime() - a.lastSentAt.getTime())[0] ??
      null,
    findUnique: async ({ where }: { where: { tokenHash: string } }) => {
      const row = rows.find((r) => r.tokenHash === where.tokenHash);
      return row ? { ...row, account, organization } : null;
    },
    create: async ({ data }: { data: Partial<Row> }) => {
      const now = new Date();
      const row: Row = {
        id: rows.length + 1,
        attempts: 0,
        sendCount: 1,
        consumedAt: null,
        createdAt: now,
        lastSentAt: now,
        ...data,
      } as Row;
      rows.push(row);
      return { ...row };
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: number };
      data: Record<string, unknown>;
    }) => {
      const row = rows.find((r) => r.id === where.id)!;
      apply(row, data);
      return { ...row };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Where;
      data: Record<string, unknown>;
    }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) apply(row, data);
      return { count: hit.length };
    },
  };
  const control = {
    loginChallenge,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ loginChallenge }),
  };
  return { control, rows, account, organization };
}

function setup({ failEmail = false } = {}) {
  const { control, rows, account, organization } = fakeControl();
  const sent: MailMessage[] = [];
  const mail = {
    send: vi.fn(async (message: MailMessage) => {
      if (failEmail) throw new Error('Resend is down');
      sent.push(message);
    }),
  };
  const config = {
    get: () => undefined,
    getOrThrow: () => 'x'.repeat(32),
  };
  const service = new LoginCodeService(
    config as unknown as ConfigService,
    control as unknown as ControlPrismaService,
    mail as unknown as MailService,
    {
      durations: { trustedDeviceHours: 12, rememberDeviceDays: 30 },
    } as unknown as TrustedDeviceService,
  );
  const lastCode = () =>
    /(\d{6}) is your Pango login code/.exec(sent.at(-1)!.subject)![1];
  const start = () => service.start({ account, organization });
  return { service, rows, sent, mail, lastCode, start };
}

async function errorBody(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as HttpException).getResponse() as Record<string, unknown>;
  }
  throw new Error('Expected the promise to reject');
}

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

describe('LoginCodeService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('is on unless disabled', () => {
    expect(setup().service.enabled).toBe(true);
  });

  it('emails a six-digit code and keeps only its hash', async () => {
    const { start, sent, rows, lastCode } = setup();
    const { token, state } = await start();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ana@demo.co');
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect(rows[0].codeHash).not.toContain(lastCode());
    expect(rows[0].tokenHash).not.toBe(token);
    expect(state).toMatchObject({
      codeRequired: true,
      email: 'a**@demo.co',
      codeLength: 6,
      emailSent: true,
      expiresAt: new Date('2026-11-19T15:10:00Z'),
      resendAvailableAt: new Date('2026-11-19T15:01:00Z'),
    });
  });

  it('accepts the code once', async () => {
    const { service, start, lastCode } = setup();
    const { token } = await start();
    expect(await service.verify('demo', token, lastCode())).toEqual({
      accountId: 1,
      organizationId: 10,
    });
    expect(
      (await errorBody(service.verify('demo', token, lastCode()))).code,
    ).toBe('LOGIN_CHALLENGE_INVALID');
  });

  it('counts wrong codes and ends the login after the last attempt', async () => {
    const { service, start, lastCode } = setup();
    const { token } = await start();
    const code = lastCode();
    expect(
      await errorBody(service.verify('demo', token, wrong(code))),
    ).toMatchObject({
      code: 'LOGIN_CODE_INVALID',
      attemptsLeft: 4,
    });
    for (let i = 0; i < 3; i++)
      await errorBody(service.verify('demo', token, wrong(code)));
    expect(
      (await errorBody(service.verify('demo', token, wrong(code)))).code,
    ).toBe('LOGIN_CODE_ATTEMPTS_EXCEEDED');
    expect((await errorBody(service.verify('demo', token, code))).code).toBe(
      'LOGIN_CHALLENGE_INVALID',
    );
  });

  it('rejects an expired code', async () => {
    const { service, start, lastCode } = setup();
    const { token } = await start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(
      (await errorBody(service.verify('demo', token, lastCode()))).code,
    ).toBe('LOGIN_CODE_EXPIRED');
  });

  it('only works in the organization where the login started', async () => {
    const { service, start, lastCode } = setup();
    const { token } = await start();
    expect(
      (await errorBody(service.verify('other', token, lastCode()))).code,
    ).toBe('LOGIN_CHALLENGE_INVALID');
  });

  it('keeps the pending code when the password is entered again within a minute', async () => {
    const { service, start, sent, lastCode } = setup();
    const first = await start();
    const code = lastCode();
    vi.advanceTimersByTime(20_000);
    const second = await start();
    expect(sent).toHaveLength(1);
    expect(
      (await errorBody(service.verify('demo', first.token, code))).code,
    ).toBe('LOGIN_CHALLENGE_INVALID');
    expect(await service.verify('demo', second.token, code)).toMatchObject({
      accountId: 1,
    });
  });

  it('starts over with a new code after the cooldown', async () => {
    const { service, start, sent, lastCode } = setup();
    const first = await start();
    const firstCode = lastCode();
    vi.advanceTimersByTime(61_000);
    const second = await start();
    expect(sent).toHaveLength(2);
    expect(
      (await errorBody(service.verify('demo', first.token, firstCode))).code,
    ).toBe('LOGIN_CHALLENGE_INVALID');
    expect(
      await service.verify('demo', second.token, lastCode()),
    ).toMatchObject({
      organizationId: 10,
    });
  });

  it('resends a code after the cooldown and up to the limit', async () => {
    const { service, start, sent, lastCode } = setup();
    const { token } = await start();
    const firstCode = lastCode();
    expect(await errorBody(service.resend('demo', token))).toMatchObject({
      code: 'LOGIN_CODE_RESEND_TOO_SOON',
      retryAfterSeconds: 60,
    });

    vi.advanceTimersByTime(60_000);
    const state = await service.resend('demo', token);
    expect(sent).toHaveLength(2);
    expect(state.expiresAt).toEqual(new Date('2026-11-19T15:11:00Z'));
    expect(
      (await errorBody(service.verify('demo', token, firstCode))).code,
    ).toBe('LOGIN_CODE_INVALID');

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(60_000);
      await service.resend('demo', token);
    }
    vi.advanceTimersByTime(60_000);
    expect((await errorBody(service.resend('demo', token))).code).toBe(
      'LOGIN_CODE_RESEND_LIMIT',
    );
    expect(await service.verify('demo', token, lastCode())).toMatchObject({
      accountId: 1,
    });
  });

  it('reports a failed email without failing the login', async () => {
    const { start } = setup({ failEmail: true });
    const { state } = await start();
    expect(state.emailSent).toBe(false);
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('ana.perez@miempresa.co')).toBe('a***@miempresa.co');
    expect(maskEmail('jo@demo.co')).toBe('j*@demo.co');
    expect(maskEmail('a@demo.co')).toBe('a*@demo.co');
  });
});
