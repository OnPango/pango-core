import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  BusinessSector,
  ProductCount,
  TeamSize,
} from '../generated/prisma/control/enums.js';
import { SUBDOMAIN_PATTERN } from '../tenancy/subdomain.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const lowercase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const uppercase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export class LoginDto {
  @ApiProperty({ example: 'ana@miempresa.co', maxLength: 150 })
  @Transform(lowercase)
  @IsEmail()
  @MaxLength(150)
  email: string;

  @ApiProperty({
    format: 'password',
    example: 'at-least-8-chars',
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class VerifyLoginCodeDto {
  @ApiProperty({
    example: '482193',
    description: 'The six-digit code emailed after the password',
    pattern: '^\\d{6}$',
  })
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Do not ask for the code on this browser for `LOGIN_REMEMBER_DEVICE_DAYS` (default 30). ' +
      'Without it, the browser is trusted for `LOGIN_TRUSTED_DEVICE_HOURS` (default 12)',
  })
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;
}

export class SignupOrganizationDto {
  @ApiProperty({ example: 'Mi Empresa SAS', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @Length(1, 150)
  legalName: string;

  @ApiProperty({
    example: 'mi-empresa',
    pattern: SUBDOMAIN_PATTERN.source,
    description:
      'Organization subdomain (`mi-empresa.onpango.com`). Reserved names such as `www` or `api` are rejected.',
  })
  @Transform(lowercase)
  @IsString()
  @Matches(SUBDOMAIN_PATTERN, {
    message:
      'subdomain must be 2-41 lowercase letters, digits or inner hyphens',
  })
  subdomain: string;

  @ApiProperty({
    example: 'CO',
    pattern: '^[A-Z]{2}$',
    description: 'ISO 3166-1 alpha-2 code',
  })
  @Transform(uppercase)
  @Matches(/^[A-Z]{2}$/, {
    message: 'country must be an ISO 3166-1 alpha-2 code (e.g. CO)',
  })
  country: string;

  @ApiProperty({ example: 'Medellín', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  city: string;

  @ApiProperty({ enum: BusinessSector, enumName: 'BusinessSector' })
  @IsEnum(BusinessSector)
  businessSector: BusinessSector;

  @ApiProperty({
    enum: TeamSize,
    enumName: 'TeamSize',
    description: 'Team size range',
  })
  @IsEnum(TeamSize)
  teamSize: TeamSize;

  @ApiProperty({
    enum: ProductCount,
    enumName: 'ProductCount',
    description: 'Range of products managed',
  })
  @IsEnum(ProductCount)
  productCount: ProductCount;

  @ApiPropertyOptional({
    example: '900123456-7',
    maxLength: 20,
    description: 'Colombian NIT; unique when present',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 20)
  taxId?: string;

  @ApiPropertyOptional({ example: '+57 300 123 4567' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\+?[0-9 ()-]{7,20}$/, { message: 'contactPhone is not valid' })
  contactPhone?: string;
}

/** Owner sign-up: creates the account (or reuses it) and its organization. */
export class SignupDto {
  @ApiProperty({ example: 'Ana Pérez', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ example: 'ana@miempresa.co', maxLength: 150 })
  @Transform(lowercase)
  @IsEmail()
  @MaxLength(150)
  email: string;

  @ApiProperty({
    format: 'password',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'For an existing account, its current password',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

  @ApiProperty({ type: SignupOrganizationDto })
  @ValidateNested()
  @Type(() => SignupOrganizationDto)
  organization: SignupOrganizationDto;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from the `verify-email?token=` link' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: 'ana@miempresa.co' })
  @Transform(lowercase)
  @IsEmail()
  @MaxLength(150)
  email: string;
}
