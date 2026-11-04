// Response shapes for Swagger. They implement the service types, so the compiler
// flags any drift between the documentation and what the API returns.
import { ApiProperty } from '@nestjs/swagger';
import type { RoleGrant, SessionProfile } from './auth-context.js';
import type { VerificationRequiredResponse } from './auth.service.js';
import type { SessionBody } from './session-cookies.js';

export class AccountDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'ana@miempresa.co' })
  email: string;

  @ApiProperty({ example: 'Ana Pérez' })
  name: string;
}

export class OrganizationSummaryDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'mi-empresa' })
  subdomain: string;

  @ApiProperty({ example: 'Mi Empresa SAS' })
  legalName: string;
}

export class WarehouseRefDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Main warehouse' })
  name: string;
}

export class RoleGrantDto implements RoleGrant {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Owner' })
  name: string;

  @ApiProperty({
    example: true,
    description: 'System roles (Owner) cannot be deleted',
  })
  isSystem: boolean;

  @ApiProperty({
    type: WarehouseRefDto,
    nullable: true,
    description: 'Warehouse the role applies to; null = every warehouse',
  })
  warehouse: WarehouseRefDto | null;

  @ApiProperty({
    type: [String],
    example: ['role.manage', 'role.read', 'user.manage', 'user.read'],
  })
  permissions: string[];
}

export class UserProfileDto {
  @ApiProperty({ example: 1, description: 'Tenant user id' })
  id: number;

  @ApiProperty({ type: String, nullable: true, example: null })
  jobTitle: string | null;

  @ApiProperty({ type: [RoleGrantDto] })
  roles: RoleGrantDto[];
}

export class SessionProfileDto implements SessionProfile {
  @ApiProperty({ type: AccountDto })
  account: AccountDto;

  @ApiProperty({ type: OrganizationSummaryDto })
  organization: OrganizationSummaryDto;

  @ApiProperty({ type: UserProfileDto })
  user: UserProfileDto;
}

export class SessionResponseDto
  extends SessionProfileDto
  implements SessionBody
{
  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ description: 'HS256 JWT; send as `Authorization: Bearer`' })
  accessToken: string;

  @ApiProperty({
    example: 900,
    description: 'Access token lifetime in seconds',
  })
  expiresIn: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Expiry of the refresh cookie',
  })
  refreshTokenExpiresAt: Date;
}

export class SubdomainRefDto {
  @ApiProperty({ example: 'mi-empresa' })
  subdomain: string;
}

export class VerificationRequiredResponseDto implements VerificationRequiredResponse {
  @ApiProperty({ enum: [true], example: true })
  verificationRequired: true;

  @ApiProperty({ example: 'ana@miempresa.co' })
  email: string;

  @ApiProperty({ type: SubdomainRefDto })
  organization: SubdomainRefDto;

  @ApiProperty({
    example: true,
    description:
      'False if the email failed; POST /auth/verify-email/resend retries',
  })
  verificationEmailSent: boolean;
}

export class VerifyEmailResponseDto {
  @ApiProperty({ example: 'ana@miempresa.co' })
  email: string;
}
