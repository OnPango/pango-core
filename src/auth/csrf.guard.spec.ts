import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext, HttpException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard.js';

function run(request: {
  method: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}) {
  const guard = new CsrfGuard({
    get: () => 'onpango.com',
  } as unknown as ConfigService);
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, cookies: {}, ...request }),
    }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
}

const session = { pango_access_demo: 'token' };

describe('CsrfGuard', () => {
  it('rejects unsafe requests with a session cookie from a foreign origin', () => {
    expect(
      run({
        method: 'POST',
        cookies: session,
        headers: { origin: 'https://evil.com' },
      }),
    ).toBe('CSRF_REJECTED');
    expect(
      run({ method: 'DELETE', cookies: session, headers: { origin: 'null' } }),
    ).toBe('CSRF_REJECTED');
  });

  it('allows origins under the base domain', () => {
    expect(
      run({
        method: 'POST',
        cookies: session,
        headers: { origin: 'https://demo.onpango.com' },
      }),
    ).toBe(true);
  });

  it('ignores safe methods, cookie-less requests and non-browser clients', () => {
    expect(
      run({
        method: 'GET',
        cookies: session,
        headers: { origin: 'https://evil.com' },
      }),
    ).toBe(true);
    expect(
      run({ method: 'POST', headers: { origin: 'https://evil.com' } }),
    ).toBe(true);
    expect(run({ method: 'POST', cookies: session })).toBe(true);
  });
});
