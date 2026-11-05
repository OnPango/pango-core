import { Prisma } from '../generated/prisma/tenant/client.js';

/** A unique constraint rejected the write (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
