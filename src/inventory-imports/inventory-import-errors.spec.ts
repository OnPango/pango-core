import { Prisma } from '../generated/prisma/tenant/client.js';
import { isRetryable } from './inventory-import-errors.js';

const prismaError = (code: string, sqlState?: string) =>
  new Prisma.PrismaClientKnownRequestError('failed', {
    code,
    clientVersion: 'test',
    meta: sqlState
      ? { driverAdapterError: { cause: { code: sqlState, kind: 'postgres' } } }
      : undefined,
  });

describe('isRetryable', () => {
  it.each([
    ['transaction timeout', prismaError('P2028')],
    ['write conflict or deadlock', prismaError('P2034')],
    ['statement timeout', prismaError('P2010', '57014')],
    ['lock timeout', prismaError('P2010', '55P03')],
    ['deadlock', prismaError('P2010', '40P01')],
    ['serialization failure', prismaError('P2010', '40001')],
    ['connection terminated', prismaError('P2010', '57P01')],
    ['connection lost', prismaError('P2010', '08006')],
  ])('retries a %s', (_name, error) => {
    expect(isRetryable(error)).toBe(true);
  });

  it.each([
    ['unique violation', prismaError('P2002')],
    ['check violation', prismaError('P2010', '23514')],
    ['injected failure', prismaError('P2010', 'P0001')],
    ['plain error', new Error('boom')],
    ['nothing', null],
  ])('does not retry a %s', (_name, error) => {
    expect(isRetryable(error)).toBe(false);
  });
});
