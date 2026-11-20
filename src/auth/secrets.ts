import * as argon2 from 'argon2';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

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

/** Six random digits, the code of the second login step. */
export function generateLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * A six-digit code is too small to protect with a plain hash: keyed with the server
 * secret, a leaked table alone does not reveal it. Bound to its challenge, so a code
 * never works for another login.
 */
export function hashLoginCode(
  secret: string,
  challengeId: number,
  code: string,
): string {
  return createHmac('sha256', secret)
    .update(`login-code:${challengeId}:${code}`)
    .digest('hex');
}

/** Compares two hex digests in constant time. */
export function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
