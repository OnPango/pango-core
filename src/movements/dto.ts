import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Movement natures, as stored in `movement_types.nature`. */
export enum MovementNatureFilter {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
  TRANSFER = 'TRANSFER',
  ADJUSTMENT = 'ADJUSTMENT',
}

/** Whether an adjustment line adds stock or removes it. */
export enum AdjustmentDirection {
  INCREASE = 'INCREASE',
  DECREASE = 'DECREASE',
}

export const MAX_MOVEMENT_LINES = 200;
const MAX_QUANTITY = 9_999_999_999;

export class ListMovementTypesQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Only the types you can register in this warehouse (your roles there must grant ' +
      '`movement.create` and allow the type)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

export class MovementLineInputDto {
  @ApiProperty({ example: 1, description: 'Active product' })
  @IsInt()
  @Min(1)
  productId: number;

  @ApiProperty({
    example: 12,
    minimum: 0.0001,
    description: "In the product's stock unit; greater than zero",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(MAX_QUANTITY)
  quantity: number;

  @ApiPropertyOptional({
    example: 7,
    description:
      "Active location of the movement's warehouse. Omitted = the product's default " +
      "location in the warehouse, or else the warehouse's default location",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  locationId?: number;

  @ApiPropertyOptional({
    example: 'L-2026-11',
    maxLength: 40,
    description:
      'Lot code. Required for products that track lots, rejected otherwise. Adding stock ' +
      'creates the lot if it does not exist; removing stock needs an existing lot',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  lotCode?: string;

  @ApiPropertyOptional({
    example: 1500,
    minimum: 0,
    description:
      "Unit cost of stock added; updates the product's weighted average cost. Omitted " +
      '= the current average cost. Ignored when stock is removed (the average cost is used)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QUANTITY)
  unitCost?: number;

  @ApiPropertyOptional({
    enum: AdjustmentDirection,
    enumName: 'AdjustmentDirection',
    description: 'Required on `ADJUSTMENT` movements, rejected on the others',
  })
  @IsOptional()
  @IsEnum(AdjustmentDirection)
  direction?: AdjustmentDirection;
}

export class CreateMovementDto {
  @ApiProperty({
    example: 2,
    description:
      'Movement type (`GET /movement-types`). `TRANSFER` types are not supported yet',
  })
  @IsInt()
  @Min(1)
  movementTypeId: number;

  @ApiProperty({
    example: 1,
    description: 'Active warehouse where you hold `movement.create`',
  })
  @IsInt()
  @Min(1)
  warehouseId: number;

  @ApiPropertyOptional({
    example: 4,
    description: 'Active department that receives or consumes the stock',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiPropertyOptional({
    example: 'FAC-1043',
    maxLength: 40,
    description: 'External document (invoice, delivery note…)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  documentRef?: string;

  @ApiPropertyOptional({ maxLength: 2000, example: 'Reason for the movement' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    type: [MovementLineInputDto],
    minItems: 1,
    maxItems: MAX_MOVEMENT_LINES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MOVEMENT_LINES)
  @ValidateNested({ each: true })
  @Type(() => MovementLineInputDto)
  lines: MovementLineInputDto[];
}

export class ListMovementsQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Only movements of this warehouse',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Only movements with a line of this product',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  movementTypeId?: number;

  @ApiPropertyOptional({
    enum: MovementNatureFilter,
    enumName: 'MovementNature',
  })
  @IsOptional()
  @IsEnum(MovementNatureFilter)
  nature?: MovementNatureFilter;

  @ApiPropertyOptional({
    example: '2026-11-01T00:00:00-05:00',
    description: 'Occurred at or after this instant (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30T23:59:59-05:00',
    description: 'Occurred at or before this instant (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

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
