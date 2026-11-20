import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

// Hash checked when the account does not exist or has no password, so the response
// time does not reveal which emails are registered.
let timingHash: Promise<string> | undefined;

export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!hash) {
    timingHash ??= hashPassword(randomBytes(16).toString('hex'));
    await argon2.verify(await timingHash, password);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Random token handed to the client (refresh tokens, invitation links). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak does not expose usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
