import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/dto.js';

export class CreateInvitationDto {
  @ApiProperty({ example: 'carlos@miempresa.co', maxLength: 150 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(150)
  email: string;

  @ApiProperty({
    example: 2,
    description: 'Tenant role granted when the invitation is accepted',
  })
  @IsInt()
  @Min(1)
  roleId: number;

  @ApiPropertyOptional({
    example: 1,
    description:
      'Warehouse the role applies to. Required for every role except Owner, which ' +
      'applies to every warehouse',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

export class AcceptInvitationDto {
  @ApiProperty({
    description: 'Token from the `invitations/accept?token=` link',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token: string;

  @ApiPropertyOptional({
    example: 'Carlos Gómez',
    maxLength: 120,
    description: 'Required when the invited email has no account yet',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiProperty({
    format: 'password',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description:
      'New password, or the current one if the email already has an account',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}
