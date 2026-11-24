import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class DashboardQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Only this warehouse. One the user cannot read answers zeros, not an error',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;
}

export const ALERT_TREND_DEFAULT_MONTHS = 6;

export class DashboardAlertsQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({
    example: ALERT_TREND_DEFAULT_MONTHS,
    default: ALERT_TREND_DEFAULT_MONTHS,
    minimum: 1,
    maximum: 12,
    description: 'Months of the monthly trend, the current one included',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  months?: number;
}

export const LEVEL_DAYS = [7, 30, 90] as const;
export const LEVEL_DEFAULT_DAYS = 7;

export class DashboardLevelQueryDto extends DashboardQueryDto {
  @ApiPropertyOptional({
    enum: LEVEL_DAYS,
    default: LEVEL_DEFAULT_DAYS,
    description: 'Days back: one point per day for 7 and 30, per week for 90',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn(LEVEL_DAYS)
  days?: (typeof LEVEL_DAYS)[number];
}
