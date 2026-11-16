import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsISO8601, IsOptional, Min } from 'class-validator';

/** Period length, as stored in `settings.forecast_granularity`. */
export enum GranularityValue {
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export class DemandQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Only this warehouse. Omitted = every warehouse where you hold `forecast.read`',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({
    enum: GranularityValue,
    enumName: 'Granularity',
    description: "Omitted = the organization's forecast granularity",
  })
  @IsOptional()
  @IsEnum(GranularityValue)
  granularity?: GranularityValue;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description:
      'First day (ISO 8601 date, snapped to the start of its period). Omitted = the ' +
      "period of the product's first demand",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-14',
    description:
      'Last day (ISO 8601 date, its whole period is included). Omitted = today, in the ' +
      "organization's time zone",
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
