import { isValidSubdomain, resolveSubdomain } from './subdomain.js';

describe('isValidSubdomain', () => {
  it.each(['ab', 'mi-empresa', 'demo2', 'a'.repeat(41)])('accepts %s', (s) =>
    expect(isValidSubdomain(s)).toBe(true),
  );

  it.each([
    'a',
    '-demo',
    'demo-',
    'Demo',
    'mi_empresa',
    'a'.repeat(42),
    'www',
    'api',
  ])('rejects %s', (s) => expect(isValidSubdomain(s)).toBe(false));
});

describe('resolveSubdomain', () => {
  it('prefers the X-Tenant header', () => {
    expect(
      resolveSubdomain(
        { 'x-tenant': ' Mi-Empresa ' },
        'api.onpango.com',
        'onpango.com',
      ),
    ).toBe('mi-empresa');
  });

  it('takes the first label of a direct subdomain of the base domain', () => {
    expect(resolveSubdomain({}, 'mi-empresa.onpango.com', 'onpango.com')).toBe(
      'mi-empresa',
    );
    expect(resolveSubdomain({}, 'demo.localhost', 'localhost')).toBe('demo');
  });

  it('returns null for the base domain, nested, reserved or foreign hosts', () => {
    expect(resolveSubdomain({}, 'onpango.com', 'onpango.com')).toBeNull();
    expect(resolveSubdomain({}, 'a.b.onpango.com', 'onpango.com')).toBeNull();
    expect(resolveSubdomain({}, 'api.onpango.com', 'onpango.com')).toBeNull();
    expect(resolveSubdomain({}, 'demo.evil.com', 'onpango.com')).toBeNull();
    expect(resolveSubdomain({}, 'evilonpango.com', 'onpango.com')).toBeNull();
  });

  it('returns null without a base domain or header', () => {
    expect(resolveSubdomain({}, 'demo.onpango.com', undefined)).toBeNull();
  });
});
