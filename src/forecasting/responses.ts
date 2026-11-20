import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { MovementUserDto } from '../movements/responses.js';

const runStatus = {
  enum: ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'],
  enumName: 'ForecastRunStatus',
} as const;

export class ForecastRunDto {
  @ApiProperty({ example: 41 })
  id: number;

  @ApiProperty({
    example: 'b3c6c3f2-5f5c-4c47-9a0e-1e2f3a4b5c6d',
    description: '`request_id` sent to the forecasting service',
  })
  requestId: string;

  @ApiProperty({
    ...runStatus,
    description:
      '`PARTIAL`: some series failed (`seriesError`); `FAILED`: the service could ' +
      'not be used and nothing was stored',
  })
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';

  @ApiProperty({ enum: ['WEEKLY', 'MONTHLY'], enumName: 'Granularity' })
  granularity: 'WEEKLY' | 'MONTHLY';

  @ApiProperty({ example: 4, description: 'Periods forecast' })
  horizon: number;

  @ApiProperty({
    example: '2026-11-15',
    description: 'Last day of history used: the last complete Sunday',
  })
  historyEnd: string;

  @ApiProperty({ type: MovementUserDto, nullable: true })
  startedBy: MovementUserDto | null;

  @ApiProperty({ example: 120, description: 'Series sent' })
  seriesTotal: number;

  @ApiProperty({ example: 100, description: 'Series forecast' })
  seriesOk: number;

  @ApiProperty({
    example: 15,
    description:
      'Series the service could not forecast (see each forecast `error`)',
  })
  seriesError: number;

  @ApiProperty({
    example: 5,
    description:
      'Series the service declined on purpose (`NO_FORECAST`, see each `reason`)',
  })
  seriesNoForecast: number;

  @ApiProperty({ example: 'development-1', type: String, nullable: true })
  policyVersion: string | null;

  @ApiProperty({ example: '0.1.0', type: String, nullable: true })
  serviceVersion: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why the run FAILED; nothing is saved from a failed run',
  })
  errorMessage: string | null;

  @ApiProperty()
  startedAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  finishedAt: Date | null;
}

export class ForecastRunPageDto {
  @ApiProperty({ type: [ForecastRunDto] })
  items: ForecastRunDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class ForecastIntervalDto {
  @ApiProperty({ example: 12 })
  estimate: number;

  @ApiProperty({ example: 0 })
  lower: number;

  @ApiProperty({ example: 24 })
  upper: number;
}

export class ForecastPeriodDto extends ForecastIntervalDto {
  @ApiProperty({ example: '2026-11-16', description: 'Monday of the week' })
  periodStart: string;
}

export class ForecastErrorDto {
  @ApiProperty({ example: 'INSUFFICIENT_HISTORY' })
  code: string;

  @ApiProperty({
    example: 'The series does not contain enough observable history.',
  })
  message: string;
}

export class ForecastDto {
  @ApiProperty({ example: 7 })
  id: number;

  @ApiProperty({ example: 41 })
  runId: number;

  @ApiProperty({ example: '2026-11-15' })
  historyEnd: string;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({
    enum: ['OK', 'ERROR', 'NO_FORECAST'],
    enumName: 'ForecastStatus',
    description:
      '`NO_FORECAST`: the service declined the series on purpose (see `reason`)',
  })
  status: 'OK' | 'ERROR' | 'NO_FORECAST';

  @ApiProperty({
    example: 'inactive',
    type: String,
    nullable: true,
    description:
      'Why it was declined: `inactive`, `sold_to_order`, `non_stock_warehouse`, ' +
      '`no_active_warehouse` or `history_only`',
  })
  reason: string | null;

  @ApiProperty({ example: 'naive', type: String, nullable: true })
  modelName: string | null;

  @ApiProperty({ example: 'development', type: String, nullable: true })
  modelVersion: string | null;

  @ApiProperty({
    enum: [
      'SMOOTH',
      'INTERMITTENT',
      'ERRATIC',
      'LUMPY',
      'INSUFFICIENT',
      'NOT_CLASSIFIABLE',
    ],
    enumName: 'DemandClass',
    nullable: true,
  })
  demandClass: string | null;

  @ApiProperty({
    type: ForecastIntervalDto,
    nullable: true,
    description: 'Calibrated interval of the whole horizon',
  })
  total: ForecastIntervalDto | null;

  @ApiProperty({ type: [ForecastPeriodDto] })
  periods: ForecastPeriodDto[];

  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      "The service's profile: history class, stock handling, ADI, CV², activity…",
  })
  profile: Record<string, unknown> | null;

  @ApiProperty({ type: [String] })
  warnings: string[];

  @ApiProperty({
    type: [Number],
    example: [4.6, 5.6, 4.6, 5.6],
    description: 'Equivalent business days of each period',
  })
  horizonBusinessDays: number[];

  @ApiProperty({ type: ForecastErrorDto, nullable: true })
  error: ForecastErrorDto | null;

  @ApiProperty({
    example: true,
    description: 'The latest successful forecast of this product and warehouse',
  })
  isCurrent: boolean;

  @ApiProperty()
  createdAt: Date;
}

export class ForecastPageDto {
  @ApiProperty({ type: [ForecastDto] })
  items: ForecastDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
