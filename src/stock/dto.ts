import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Query strings arrive as text: `true` / `false`. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class WarehouseQueryDto {
  @ApiProperty({ example: 1, description: 'You need `stock.read` there' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId: number;
}

export class ListStockQueryDto extends WarehouseQueryDto {
  @ApiPropertyOptional({
    example: 'tornillo',
    maxLength: 150,
    description: 'Case-insensitive match on the product SKU or name',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'Only products of this category or its subcategories',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  categoryId?: number;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Also list the products enabled in the warehouse with no stock (on hand = 0)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeZero?: boolean;

  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 25, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class UpdateLotDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    nullable: true,
    description: 'ISO 8601 date; null clears it',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  manufactureDate?: string | null;

  @ApiPropertyOptional({
    example: '2027-04-30',
    nullable: true,
    description:
      'ISO 8601 date, not before the manufacture date; null clears it',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601({ strict: true })
  expiryDate?: string | null;
}
