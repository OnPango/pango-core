import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const MAX_QUANTITY = 9_999_999_999;

/** Alert statuses, as stored in `alerts.status`. */
export enum AlertStatusFilter {
  OPEN = 'OPEN',
  ATTENDED = 'ATTENDED',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

/** What a person can set by hand (US-045): pending again, or attended. */
export enum AlertManualStatus {
  OPEN = 'OPEN',
  ATTENDED = 'ATTENDED',
}

export class SetAlertStatusDto {
  @ApiProperty({
    enum: AlertManualStatus,
    enumName: 'AlertManualStatus',
    example: AlertManualStatus.ATTENDED,
  })
  @IsEnum(AlertManualStatus)
  status: AlertManualStatus;
}

/** Methods that can be set: how the reorder point in force is obtained. */
export enum ReorderMethod {
  /** The manual values are in force. */
  FIXED_ROP = 'FIXED_ROP',
  /** Computed from the current forecast; the manual values are the fallback. */
  FORECAST_ROP = 'FORECAST_ROP',
}

/** Order of `GET /alerts`. */
export enum AlertSort {
  /** Most recently raised first (default). */
  CREATED = 'CREATED',
  /** Most recently changed first: raised, refreshed (e.g. severity raised) or resolved. */
  UPDATED = 'UPDATED',
  /** Most severe first, then most recently changed. */
  SEVERITY = 'SEVERITY',
}

export class SetReplenishmentDto {
  @ApiProperty({
    example: 10,
    minimum: 0,
    description: "In the product's stock unit; not above the reorder point",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QUANTITY)
  safetyStock: number;

  @ApiProperty({
    example: 30,
    minimum: 0,
    description:
      'Available stock at or below this value raises an alert. `0` = no reorder point ' +
      '(no alerts)',
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QUANTITY)
  reorderPoint: number;

  @ApiPropertyOptional({
    example: 20,
    minimum: 0,
    nullable: true,
    description: 'Omitted or null = none',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QUANTITY)
  minStock?: number | null;

  @ApiPropertyOptional({
    example: 120,
    minimum: 0,
    nullable: true,
    description:
      'Not below `minStock` or the reorder point. Alerts suggest ordering up to it. ' +
      'Omitted or null = none',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_QUANTITY)
  maxStock?: number | null;

  @ApiPropertyOptional({
    enum: ReorderMethod,
    enumName: 'ReorderMethod',
    description:
      '`FIXED_ROP`: the values above are in force. `FORECAST_ROP`: the safety stock ' +
      'and reorder point are computed from the current forecast and the lead time, ' +
      'and the values above are the fallback when that is not possible. Omitted = ' +
      'keep the current one (`FIXED_ROP` for a product not yet enabled)',
  })
  @IsOptional()
  @IsEnum(ReorderMethod)
  replenishmentMethod?: ReorderMethod;

  @ApiPropertyOptional({
    example: 7,
    minimum: 1,
    maximum: 365,
    description:
      'Days from ordering to having the stock available. Omitted = keep the current ' +
      'one (7 for a product not yet enabled)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  leadTimeDays?: number;
}

export class ListAlertsQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Only alerts of this warehouse',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({
    example: 1,
    description: 'Only alerts of this product',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({ enum: AlertStatusFilter, enumName: 'AlertStatus' })
  @IsOptional()
  @IsEnum(AlertStatusFilter)
  status?: AlertStatusFilter;

  @ApiPropertyOptional({
    enum: AlertSort,
    enumName: 'AlertSort',
    default: AlertSort.CREATED,
    description:
      '`CREATED`: most recently raised first. `UPDATED`: most recently changed ' +
      'first, so an old alert that just reached a higher severity comes up. ' +
      '`SEVERITY`: most severe first, then most recently changed',
  })
  @IsOptional()
  @IsEnum(AlertSort)
  sort?: AlertSort;

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
