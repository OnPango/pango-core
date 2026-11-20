import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { MovementProductDto } from '../movements/responses.js';

export class DemandPeriodDto {
  @ApiProperty({
    example: '2026-11-09',
    description: 'First day of the period (weeks start on Monday)',
  })
  periodStart: string;

  @ApiProperty({
    example: 12,
    description:
      "Demand in the product's stock unit; 0 when nothing was consumed",
  })
  quantity: number;
}

export class DemandSeriesDto {
  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({
    type: WarehouseRefDto,
    nullable: true,
    description: 'Null = the sum of every warehouse you can read',
  })
  warehouse: WarehouseRefDto | null;

  @ApiProperty({ enum: ['WEEKLY', 'MONTHLY'], enumName: 'Granularity' })
  granularity: 'WEEKLY' | 'MONTHLY';

  @ApiProperty({
    example: 'America/Bogota',
    description: 'Time zone the periods are computed in',
  })
  timeZone: string;

  @ApiProperty({
    example: '2026-09-07',
    type: String,
    nullable: true,
    description: 'Start of the first period; null when there is no history',
  })
  from: string | null;

  @ApiProperty({
    example: '2026-11-15',
    type: String,
    nullable: true,
    description: 'Last day of the last period; null when there is no history',
  })
  to: string | null;

  @ApiProperty({
    example: 140,
    description: 'Sum of the periods',
  })
  total: number;

  @ApiProperty({
    type: [DemandPeriodDto],
    description: 'Every period of the range, oldest first, zeros included',
  })
  periods: DemandPeriodDto[];

  @ApiProperty({
    enum: ['NO_HISTORY'],
    nullable: true,
    description:
      '`NO_HISTORY` when the product has no demand at all (the series is empty)',
  })
  notice: 'NO_HISTORY' | null;
}
