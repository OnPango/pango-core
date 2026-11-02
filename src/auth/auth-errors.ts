import { HttpException, HttpStatus } from '@nestjs/common';

// Errors carry a stable `code` so the frontend can react without parsing messages.
export function apiError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
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
