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

/** Request types, as stored in `stock_requests.type` (RF-REQ-007). */
export enum StockRequestTypeValue {
  INTERNAL_CONSUMPTION = 'INTERNAL_CONSUMPTION',
  INTERNAL_REPLENISHMENT = 'INTERNAL_REPLENISHMENT',
  RETURN = 'RETURN',
  INCIDENT = 'INCIDENT',
}

/** Request statuses, as stored in `stock_requests.status` (RF-REQ-003). */
export enum StockRequestStatusValue {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  FULFILLED = 'FULFILLED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export const MAX_REQUEST_LINES = 200;
const MAX_QUANTITY = 9_999_999_999;

export class StockRequestLineInputDto {
  @ApiProperty({ example: 1, description: 'Active product, once per request' })
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
}

export class CreateStockRequestDto {
  @ApiProperty({
    example: 1,
    description:
      'Warehouse that attends the request; you need `stock_request.create` there',
  })
  @IsInt()
  @Min(1)
  warehouseId: number;

  @ApiPropertyOptional({
    enum: StockRequestTypeValue,
    enumName: 'StockRequestType',
    default: StockRequestTypeValue.INTERNAL_CONSUMPTION,
    description: 'Only `INTERNAL_CONSUMPTION` is supported for now',
  })
  @IsOptional()
  @IsEnum(StockRequestTypeValue)
  type?: StockRequestTypeValue;

  @ApiPropertyOptional({
    example: 2,
    default: 2,
    minimum: 1,
    maximum: 3,
    description: '1 = highest',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  priority?: number;

  @ApiPropertyOptional({ example: '2026-11-15', description: 'ISO 8601 date' })
  @IsOptional()
  @IsISO8601({ strict: true })
  requiredDate?: string;

  @ApiPropertyOptional({ maxLength: 2000, example: 'For the night shift' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    type: [StockRequestLineInputDto],
    minItems: 1,
    maxItems: MAX_REQUEST_LINES,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_REQUEST_LINES)
  @ValidateNested({ each: true })
  @Type(() => StockRequestLineInputDto)
  lines: StockRequestLineInputDto[];
}

export class RejectStockRequestDto {
  @ApiProperty({ example: 'The product is reserved for production' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;
}

export class FulfilLineInputDto {
  @ApiProperty({ example: 1, description: 'Line of the request' })
  @IsInt()
  @Min(1)
  lineNumber: number;

  @ApiPropertyOptional({
    example: 7,
    description:
      "Location to take the stock from. Omitted = the product's default location in " +
      "the warehouse, or else the warehouse's default location",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  locationId?: number;

  @ApiPropertyOptional({
    example: 'L-2026-11',
    maxLength: 40,
    description: 'Lot to take; required for products that track lots',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  lotCode?: string;
}

export class FulfilStockRequestDto {
  @ApiPropertyOptional({
    type: [FulfilLineInputDto],
    description:
      'Where to take each line from; lines not listed use the defaults',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_REQUEST_LINES)
  @ValidateNested({ each: true })
  @Type(() => FulfilLineInputDto)
  lines?: FulfilLineInputDto[];

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Notes of the movement',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ListStockRequestsQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({ example: 4, description: 'Requesting department' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Only requests with a line of this product',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({
    enum: StockRequestStatusValue,
    enumName: 'StockRequestStatus',
  })
  @IsOptional()
  @IsEnum(StockRequestStatusValue)
  status?: StockRequestStatusValue;

  @ApiPropertyOptional({
    example: '2026-11-01T00:00:00-05:00',
    description: 'Created at or after this instant (ISO 8601)',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30T23:59:59-05:00',
    description: 'Created at or before this instant (ISO 8601)',
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
