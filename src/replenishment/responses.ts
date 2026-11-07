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

  @ApiProperty({ example: 2, description: '1 = lowest, 3 = nothing available' })
  severity: number;

  @ApiProperty()
  createdAt: Date;
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
    description: 'Held by approved stock requests',
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
    enum: ['OPEN', 'RESOLVED', 'DISMISSED'],
    enumName: 'AlertStatus',
  })
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';

  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({
    example: 8,
    description: 'Available stock when the alert was raised',
  })
  availableQuantity: number;

  @ApiProperty({
    example: 30,
    description: 'Reorder point the stock was compared against',
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
      'point when there is none), when the alert was raised',
  })
  suggestedQuantity: number;

  @ApiProperty({
    example:
      'TOR-001: available stock 8 EA is at or below the reorder point 30',
  })
  message: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: Date, nullable: true })
  resolvedAt: Date | null;
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
