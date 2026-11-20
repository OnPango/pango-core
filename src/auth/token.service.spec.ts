import type { ConfigService } from '@nestjs/config';
import { TokenService } from './token.service.js';

function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`${key} missing`);
      return values[key];
    },
  } as unknown as ConfigService;
}

const SECRET = 'x'.repeat(32);

describe('TokenService', () => {
  it('round-trips the account and organization', async () => {
    const tokens = new TokenService(configWith({ JWT_SECRET: SECRET }));
    const token = await tokens.signAccessToken({
      accountId: 7,
      organizationId: 3,
    });
    await expect(tokens.verifyAccessToken(token)).resolves.toEqual({
      accountId: 7,
      organizationId: 3,
    });
  });

  it('rejects tokens signed with another secret', async () => {
    const other = new TokenService(configWith({ JWT_SECRET: 'y'.repeat(32) }));
    const token = await other.signAccessToken({
      accountId: 7,
      organizationId: 3,
    });
    const tokens = new TokenService(configWith({ JWT_SECRET: SECRET }));
    await expect(tokens.verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a short secret', () => {
    expect(() => new TokenService(configWith({ JWT_SECRET: 'short' }))).toThrow(
      /at least 32/,
    );
  });

  it('reads the TTLs from the config', () => {
    const tokens = new TokenService(
      configWith({
        JWT_SECRET: SECRET,
        JWT_ACCESS_TTL_SECONDS: '60',
        REFRESH_TOKEN_TTL_DAYS: '1',
      }),
    );
    expect(tokens.accessTtlSeconds).toBe(60);
    expect(tokens.refreshTtlMs).toBe(86_400_000);
  });
});
