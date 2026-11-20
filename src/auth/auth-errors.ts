import { HttpException, HttpStatus } from '@nestjs/common';

// Errors carry a stable `code` so the frontend can react without parsing messages, and
// sometimes extra fields it needs to act (`attemptsLeft`, `retryAfterSeconds`).
export function apiError(
  status: HttpStatus,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): HttpException {
  return new HttpException(
    { statusCode: status, code, message, ...extra },
    status,
  );
}

export const authErrors = {
  tenantRequired: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'TENANT_REQUIRED',
      'The organization subdomain is required',
    ),
  organizationNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'ORGANIZATION_NOT_FOUND',
      'Organization not found',
    ),
  organizationInactive: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'ORGANIZATION_INACTIVE',
      'This organization is not active',
    ),
  invalidCredentials: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'INVALID_CREDENTIALS',
      'Invalid email or password',
    ),
  notAMember: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'NOT_A_MEMBER',
      'This user does not belong to this organization',
    ),
  membershipSuspended: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'MEMBERSHIP_SUSPENDED',
      'Your access to this organization is suspended',
    ),
  accountDisabled: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'ACCOUNT_DISABLED',
      'This account is disabled',
    ),
  userDisabled: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'USER_DISABLED',
      'This user is disabled in this organization',
    ),
  emailNotVerified: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'EMAIL_NOT_VERIFIED',
      'Confirm your email address before logging in',
    ),
  verificationTokenInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'VERIFICATION_TOKEN_INVALID',
      'This confirmation link is invalid, was already used or has expired',
    ),
  loginChallengeInvalid: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'LOGIN_CHALLENGE_INVALID',
      'This login is no longer pending; log in again',
    ),
  loginCodeInvalid: (attemptsLeft: number) =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'LOGIN_CODE_INVALID',
      'The code is not correct',
      { attemptsLeft },
    ),
  loginCodeExpired: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'LOGIN_CODE_EXPIRED',
      'The code has expired; request a new one',
    ),
  loginCodeAttemptsExceeded: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'LOGIN_CODE_ATTEMPTS_EXCEEDED',
      'Too many wrong codes; log in again',
    ),
  loginCodeResendTooSoon: (retryAfterSeconds: number) =>
    apiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'LOGIN_CODE_RESEND_TOO_SOON',
      'Wait before requesting another code',
      { retryAfterSeconds },
    ),
  loginCodeResendLimit: () =>
    apiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'LOGIN_CODE_RESEND_LIMIT',
      'No more codes can be sent for this login; log in again',
    ),
  unauthenticated: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'UNAUTHENTICATED',
      'Missing, invalid or expired access token',
    ),
  invalidRefreshToken: () =>
    apiError(
      HttpStatus.UNAUTHORIZED,
      'INVALID_REFRESH_TOKEN',
      'Invalid or expired refresh token',
    ),
  tenantMismatch: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'TENANT_MISMATCH',
      'This session belongs to a different organization',
    ),
  forbidden: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'FORBIDDEN',
      'You do not have permission to perform this action',
    ),
  emailTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'EMAIL_TAKEN',
      'An account with this email already exists; use its password to create another organization',
    ),
  subdomainInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'SUBDOMAIN_INVALID',
      'This subdomain is not allowed',
    ),
  subdomainTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'SUBDOMAIN_TAKEN',
      'This subdomain is already in use',
    ),
  taxIdTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'TAX_ID_TAKEN',
      'An organization with this tax ID already exists',
    ),
};
