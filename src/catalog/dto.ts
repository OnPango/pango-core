import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum CatalogStatusFilter {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ALL = 'ALL',
}

// ─── Products ───────────────────────────────────────────────────────────────

export class ListProductsQueryDto {
  @ApiPropertyOptional({
    example: 'tornillo',
    maxLength: 150,
    description: 'Case-insensitive match on code or name',
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
    enum: CatalogStatusFilter,
    enumName: 'CatalogStatusFilter',
    default: CatalogStatusFilter.ACTIVE,
  })
  @IsOptional()
  @IsEnum(CatalogStatusFilter)
  status?: CatalogStatusFilter;

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

function measure(example: number, description: string) {
  return ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    example,
    description: `${description}; null clears it`,
  });
}

export class CreateProductDto {
  @ApiProperty({
    example: 'TOR-001',
    maxLength: 40,
    description: 'Product code, unique in the organization (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  sku: string;

  @ApiProperty({ example: 'Hex bolt 1/4"', maxLength: 150 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ example: 3, description: 'Family (category); must be active' })
  @IsInt()
  @Min(1)
  categoryId: number;

  @ApiProperty({ example: 1, description: 'See `GET /units-of-measure`' })
  @IsInt()
  @Min(1)
  unitOfMeasureId: number;

  @measure(5, 'Length in centimetres')
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  lengthCm?: number | null;

  @measure(2, 'Width in centimetres')
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  widthCm?: number | null;

  @measure(1, 'Height in centimetres')
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  heightCm?: number | null;

  @measure(0.012, 'Weight in kilograms')
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99_999_999)
  weightKg?: number | null;

  @measure(0.01, 'Volume in litres')
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(9_999_999_999)
  volumeL?: number | null;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      'Stock is kept per lot. Locked once the product has movements or lots',
  })
  @IsOptional()
  @IsBoolean()
  tracksLots?: boolean;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @ApiPropertyOptional({
    example: true,
    description: 'false retires the product; products are never deleted',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Categories ─────────────────────────────────────────────────────────────

export class ListCategoriesQueryDto {
  @ApiPropertyOptional({
    enum: CatalogStatusFilter,
    enumName: 'CatalogStatusFilter',
    default: CatalogStatusFilter.ALL,
  })
  @IsOptional()
  @IsEnum(CatalogStatusFilter)
  status?: CatalogStatusFilter;
}

export class CreateCategoryDto {
  @ApiProperty({
    example: 'Hardware',
    maxLength: 80,
    description: 'Unique among its siblings (case-insensitive)',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: null,
    description: 'Parent category; null or omitted = top level',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @ApiPropertyOptional({
    example: true,
    description:
      'false hides the category from new products; its products keep it',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
