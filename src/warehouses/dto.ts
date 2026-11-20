import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { WarehouseType } from '../generated/prisma/tenant/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum WarehouseStatusFilter {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ALL = 'ALL',
}

export class ListWarehousesQueryDto {
  @ApiPropertyOptional({
    example: 'norte',
    maxLength: 80,
    description: 'Case-insensitive match on code or name',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ enum: WarehouseType, enumName: 'WarehouseType' })
  @IsOptional()
  @IsEnum(WarehouseType)
  type?: WarehouseType;

  @ApiPropertyOptional({
    enum: WarehouseStatusFilter,
    enumName: 'WarehouseStatusFilter',
    default: WarehouseStatusFilter.ACTIVE,
  })
  @IsOptional()
  @IsEnum(WarehouseStatusFilter)
  status?: WarehouseStatusFilter;
}

export class CreateWarehouseDto {
  @ApiProperty({
    example: 'BOD-NORTE',
    maxLength: 20,
    description: 'Short code, unique in the organization (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;

  @ApiProperty({
    example: 'Bodega Norte',
    maxLength: 80,
    description: 'Unique in the organization (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiProperty({
    enum: WarehouseType,
    enumName: 'WarehouseType',
    description:
      '`WAREHOUSE` = storage (bodega), `STORE` = point of sale (tienda)',
  })
  @IsEnum(WarehouseType)
  type: WarehouseType;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cra 50 # 80-20, Barranquilla',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  address?: string | null;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'false for a warehouse that never holds stock (e.g. sells to order): its ' +
      'demand does not drive replenishment and its products are not forecast',
  })
  @IsOptional()
  @IsBoolean()
  holdsStock?: boolean;
}

export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {
  @ApiPropertyOptional({
    example: true,
    description:
      'false closes the warehouse; only allowed when it has no stock on hand',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
