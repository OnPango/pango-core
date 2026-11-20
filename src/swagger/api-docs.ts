import { applyDecorators, HttpStatus } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiResponse,
  ApiSecurity,
  getSchemaPath,
} from '@nestjs/swagger';
import { ACCESS_COOKIE_AUTH, BEARER_AUTH, TENANT_AUTH } from './swagger.js';

/** Body of every application error (see `apiError`). */
export class ApiErrorDto {
  @ApiProperty({ example: 403 })
  statusCode: number;

  @ApiProperty({
    example: 'NOT_A_MEMBER',
    description: 'Stable error code; branch on it',
  })
  code: string;

  @ApiProperty({ example: 'This user does not belong to this organization' })
  message: string;
}

/** Body of a request rejected by ValidationPipe. */
export class ValidationErrorDto {
  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ type: [String], example: ['email must be an email'] })
  message: string[];

  @ApiProperty({ example: 'Bad Request' })
  error: string;
}

/** Error codes an endpoint can return, by HTTP status. */
export type ErrorCodes = Partial<Record<HttpStatus, string[]>>;

export interface ApiEndpointOptions {
  /** The body or parameters are validated (adds the ValidationPipe 400 shape). */
  validation?: boolean;
  errors?: ErrorCodes;
}

const code = (value: string) => `\`${value}\``;

// One response per status: Swagger keeps only the last decorator for a status.
function errorResponses({ validation, errors = {} }: ApiEndpointOptions) {
  const statuses = new Set(Object.keys(errors).map(Number));
  if (validation) statuses.add(HttpStatus.BAD_REQUEST);
  return [...statuses]
    .sort((a, b) => a - b)
    .map((status) => {
      const codes = errors[status as HttpStatus] ?? [];
      const withValidation = validation && status === HttpStatus.BAD_REQUEST;
      const description = [
        codes.length > 0 ? codes.map(code).join(', ') : '',
        withValidation ? 'Validation error (message is an array)' : '',
      ]
        .filter(Boolean)
        .join('; ');
      if (withValidation && codes.length > 0) {
        return ApiResponse({
          status,
          description,
          schema: {
            oneOf: [
              { $ref: getSchemaPath(ApiErrorDto) },
              { $ref: getSchemaPath(ValidationErrorDto) },
            ],
          },
        });
      }
      return ApiResponse({
        status,
        description,
        type: withValidation ? ValidationErrorDto : ApiErrorDto,
      });
    });
}

function merge(a: ErrorCodes, b: ErrorCodes = {}): ErrorCodes {
  const result: ErrorCodes = { ...a };
  for (const [status, codes] of Object.entries(b)) {
    const key = Number(status) as HttpStatus;
    result[key] = [...new Set([...(result[key] ?? []), ...(codes ?? [])])];
  }
  return result;
}

/**
 * Public route (no session). `tenant: true` when it targets an organization
 * (X-Tenant header or subdomain host).
 */
export function ApiPublic(
  options: ApiEndpointOptions & { tenant?: boolean } = {},
) {
  return applyDecorators(
    ApiExtraModels(ApiErrorDto, ValidationErrorDto),
    ...(options.tenant ? [ApiSecurity(TENANT_AUTH)] : []),
    ...errorResponses(options),
  );
}

/**
 * Route behind AuthGuard: access token + organization. Adds the errors the guard
 * itself returns, and the required permissions.
 */
export function ApiSession(
  options: ApiEndpointOptions & { permissions?: string[] } = {},
) {
  const permissions = options.permissions ?? [];
  const guardErrors: ErrorCodes = {
    [HttpStatus.BAD_REQUEST]: ['TENANT_REQUIRED'],
    [HttpStatus.UNAUTHORIZED]: ['UNAUTHENTICATED'],
    [HttpStatus.FORBIDDEN]: [
      'CSRF_REJECTED',
      'TENANT_MISMATCH',
      'NOT_A_MEMBER',
      'MEMBERSHIP_SUSPENDED',
      'ACCOUNT_DISABLED',
      'EMAIL_NOT_VERIFIED',
      'ORGANIZATION_INACTIVE',
      'USER_DISABLED',
      ...(permissions.length > 0 ? ['FORBIDDEN'] : []),
    ],
  };
  return applyDecorators(
    ApiExtraModels(ApiErrorDto, ValidationErrorDto),
    // Schemes in one requirement are all sent; separate requirements are alternatives:
    // (access cookie + tenant) or (bearer + tenant).
    ApiSecurity({ [ACCESS_COOKIE_AUTH]: [], [TENANT_AUTH]: [] }),
    ApiSecurity({ [BEARER_AUTH]: [], [TENANT_AUTH]: [] }),
    ...errorResponses({
      validation: options.validation,
      errors: merge(guardErrors, options.errors),
    }),
  );
}

/** Text for ApiOperation descriptions listing the required permissions. */
export function requiresPermissions(...permissions: string[]): string {
  return `Requires ${permissions.map(code).join(', ')}.`;
}
