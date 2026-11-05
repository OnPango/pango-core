import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateRoleDto {
  @ApiProperty({
    example: 'Store clerk',
    maxLength: 60,
    description: 'Unique in the organization (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiProperty({
    type: [String],
    example: ['catalog.read', 'stock.read', 'movement.create'],
    description: 'Permission codes; see `GET /permissions`',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissions: string[];
}

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
