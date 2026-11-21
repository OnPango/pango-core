import type { ConfigService } from '@nestjs/config';
import { TrustedDeviceService } from './trusted-device.service.js';

function service(values: Record<string, string> = {}) {
  const config = {
    get: (key: string) => values[key],
    getOrThrow: () => 'x'.repeat(32),
  };
  return new TrustedDeviceService(config as unknown as ConfigService);
}

const account = { id: 1, passwordHash: '$argon2id$v=19$hash' };
const now = new Date('2026-11-21T10:00:00Z');
const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000);

describe('TrustedDeviceService', () => {
  it('trusts the browser for 12 hours, or 30 days when asked to remember it', () => {
    const devices = service();
    const short = devices.issue(account, 10, false, now)!;
    expect(short.maxAgeMs).toBe(12 * 3_600_000);
    expect(devices.isTrusted(short.token, account, 10, later(11))).toBe(true);
    expect(devices.isTrusted(short.token, account, 10, later(12))).toBe(false);

    const long = devices.issue(account, 10, true, now)!;
    expect(long.maxAgeMs).toBe(30 * 86_400_000);
    expect(devices.isTrusted(long.token, account, 10, later(29 * 24))).toBe(
      true,
    );
    expect(devices.durations).toEqual({
      trustedDeviceHours: 12,
      rememberDeviceDays: 30,
    });
  });

  it('only trusts the same account, organization and password', () => {
    const devices = service();
    const { token } = devices.issue(account, 10, true, now)!;
    expect(devices.isTrusted(token, { ...account, id: 2 }, 10, now)).toBe(
      false,
    );
    expect(devices.isTrusted(token, account, 11, now)).toBe(false);
    expect(
      devices.isTrusted(
        token,
        { ...account, passwordHash: 'changed' },
        10,
        now,
      ),
    ).toBe(false);
  });

  it('rejects tampered or malformed tokens', () => {
    const devices = service();
    const { token } = devices.issue(account, 10, false, now)!;
    const [acc, org, expires, signature] = token.split('.');
    // A later expiry with the old signature.
    expect(
      devices.isTrusted(
        `${acc}.${org}.${Number(expires) + 86_400}.${signature}`,
        account,
        10,
        now,
      ),
    ).toBe(false);
    expect(
      devices.isTrusted(`${acc}.${org}.${expires}.x`, account, 10, now),
    ).toBe(false);
    expect(devices.isTrusted('garbage', account, 10, now)).toBe(false);
    expect(devices.isTrusted(null, account, 10, now)).toBe(false);
  });

  it('gives no automatic trust with LOGIN_TRUSTED_DEVICE_HOURS=0', () => {
    const devices = service({
      LOGIN_TRUSTED_DEVICE_HOURS: '0',
      LOGIN_REMEMBER_DEVICE_DAYS: '7',
    });
    expect(devices.issue(account, 10, false, now)).toBeNull();
    expect(devices.issue(account, 10, true, now)!.maxAgeMs).toBe(
      7 * 86_400_000,
    );
  });
});
