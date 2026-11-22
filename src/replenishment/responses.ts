import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { MovementProductDto } from '../movements/responses.js';

const valueSource = {
  enum: ['MANUAL', 'CALCULATED'],
  enumName: 'ValueSource',
} as const;

export class OpenAlertRefDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({
    enum: ['OPEN', 'ATTENDED'],
    enumName: 'AlertStatus',
    description: 'Pending, or attended and still in force',
  })
  status: 'OPEN' | 'ATTENDED';

  @ApiProperty({ example: 2, description: '1 = lowest, 3 = nothing available' })
  severity: number;

  @ApiProperty({ description: 'When the alert was raised' })
  createdAt: Date;

  @ApiProperty({
    description: 'Last time its values changed (e.g. severity raised)',
  })
  updatedAt: Date;
}

export class ReplenishmentDto {
  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 42 })
  onHand: number;

  @ApiProperty({
    example: 2,
    description: 'Held by stock requests in attention',
  })
  reserved: number;

  @ApiProperty({
    example: 40,
    description: 'On hand − reserved; compared with the reorder point',
  })
  available: number;

  @ApiProperty({ example: 10 })
  safetyStock: number;

  @ApiProperty({ example: 30, description: '`0` = no reorder point' })
  reorderPoint: number;

  @ApiProperty({ example: 20, type: Number, nullable: true })
  minStock: number | null;

  @ApiProperty({ example: 120, type: Number, nullable: true })
  maxStock: number | null;

  @ApiProperty({
    ...valueSource,
    description:
      'Whether the values were set by hand or computed by the forecast',
  })
  valueSource: 'MANUAL' | 'CALCULATED';

  @ApiProperty({
    type: OpenAlertRefDto,
    nullable: true,
    description: 'The open below-reorder-point alert, if any',
  })
  openAlert: OpenAlertRefDto | null;
}

export class AlertAttendantDto {
  @ApiProperty({ example: 4, description: 'Tenant user id' })
  id: number;

  @ApiProperty({ example: 'Ana Gómez' })
  name: string;
}

export class AlertDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({
    enum: ['BELOW_ROP', 'STOCKOUT', 'OVERSTOCK'],
    enumName: 'AlertType',
  })
  type: 'BELOW_ROP' | 'STOCKOUT' | 'OVERSTOCK';

  @ApiProperty({
    example: 2,
    description:
      '1 = at or below the reorder point, 2 = at or below the safety stock, ' +
      '3 = nothing available',
  })
  severity: number;

  @ApiProperty({
    enum: ['OPEN', 'ATTENDED', 'RESOLVED', 'DISMISSED'],
    enumName: 'AlertStatus',
    description:
      '`OPEN` pending; `ATTENDED` someone took charge, still in force until ' +
      'resolved; `RESOLVED` closed by the evaluation',
  })
  status: 'OPEN' | 'ATTENDED' | 'RESOLVED' | 'DISMISSED';

  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({
    example: 8,
    description:
      'Available stock at the last evaluation while open; frozen once resolved',
  })
  availableQuantity: number;

  @ApiProperty({
    example: 30,
    description: 'Reorder point the stock was last compared against',
  })
  reorderPoint: number;

  @ApiProperty({
    ...valueSource,
    description: 'Whether that reorder point was set by hand or calculated',
  })
  reorderPointSource: 'MANUAL' | 'CALCULATED';

  @ApiProperty({
    example: 112,
    description:
      'Quantity that brings available stock up to the max stock (or the reorder ' +
      'point when there is none), as of the last evaluation while open',
  })
  suggestedQuantity: number;

  @ApiProperty({
    example:
      'TOR-001: available stock 8 EA is at or below the reorder point 30',
  })
  message: string;

  @ApiProperty({
    description: 'When the alert was raised; refreshing it does not change it',
  })
  createdAt: Date;

  @ApiProperty({
    description:
      'Last change: values refreshed while open (e.g. severity raised to 3) ' +
      'or resolution. Equals `createdAt` until then',
  })
  updatedAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({
    enum: [
      'STOCK_RECOVERED',
      'REORDER_POINT_CHANGED',
      'NO_REORDER_POINT',
      'INACTIVE',
    ],
    enumName: 'AlertResolution',
    nullable: true,
    description:
      'Why it was resolved: available stock rose above the reorder point, the ' +
      'reorder point was lowered below it or removed, or the product, its ' +
      'product-warehouse or the warehouse was deactivated. Null while open and ' +
      'for alerts resolved before reasons were recorded. A resolved alert keeps ' +
      'the values of its last evaluation, so with `REORDER_POINT_CHANGED` they ' +
      'still read below the reorder point',
  })
  resolution:
    | 'STOCK_RECOVERED'
    | 'REORDER_POINT_CHANGED'
    | 'NO_REORDER_POINT'
    | 'INACTIVE'
    | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'When it was marked attended; null while pending. Kept once resolved',
  })
  attendedAt: Date | null;

  @ApiProperty({
    type: AlertAttendantDto,
    nullable: true,
    description: 'Who marked it attended',
  })
  attendedBy: AlertAttendantDto | null;
}

export class AlertPageDto {
  @ApiProperty({ type: [AlertDto] })
  items: AlertDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
