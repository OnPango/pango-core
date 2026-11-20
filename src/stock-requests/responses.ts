import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import {
  DepartmentRefDto,
  MovementProductDto,
  MovementUserDto,
} from '../movements/responses.js';

const status = {
  enum: ['PENDING', 'IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED'],
  enumName: 'StockRequestStatus',
} as const;

type Status =
  'PENDING' | 'IN_PROGRESS' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';

export class StockRequestLineDto {
  @ApiProperty({ example: 1 })
  lineNumber: number;

  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ example: 12 })
  requestedQuantity: number;

  @ApiProperty({
    example: 12,
    description: 'Held for the request while it is `IN_PROGRESS`',
  })
  reservedQuantity: number;
}

export class StockRequestEventDto {
  @ApiProperty(status)
  status: Status;

  @ApiProperty({ type: MovementUserDto })
  changedBy: MovementUserDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Reason of a rejection',
  })
  reason: string | null;

  @ApiProperty()
  createdAt: Date;
}

export class MovementRefDto {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({ example: 'MV-00000012' })
  number: string;
}

export class StockRequestDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'SR-00000001' })
  number: string;

  @ApiProperty({
    enum: [
      'INTERNAL_CONSUMPTION',
      'INTERNAL_REPLENISHMENT',
      'RETURN',
      'INCIDENT',
    ],
    enumName: 'StockRequestType',
  })
  type:
    'INTERNAL_CONSUMPTION' | 'INTERNAL_REPLENISHMENT' | 'RETURN' | 'INCIDENT';

  @ApiProperty(status)
  status: Status;

  @ApiProperty({ example: 2, description: '1 = highest' })
  priority: number;

  @ApiProperty({ example: '2026-11-15', type: String, nullable: true })
  requiredDate: string | null;

  @ApiProperty({ type: WarehouseRefDto, description: 'Attending warehouse' })
  warehouse: WarehouseRefDto;

  @ApiProperty({ type: DepartmentRefDto, description: 'Requesting department' })
  department: DepartmentRefDto;

  @ApiProperty({ type: MovementUserDto })
  requestedBy: MovementUserDto;

  @ApiProperty({ type: String, nullable: true })
  notes: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Set when `REJECTED`',
  })
  rejectionReason: string | null;

  @ApiProperty({
    type: MovementRefDto,
    nullable: true,
    description: 'Outbound movement that fulfilled it',
  })
  movement: MovementRefDto | null;

  @ApiProperty({ type: [StockRequestLineDto] })
  lines: StockRequestLineDto[];

  @ApiProperty({
    type: [StockRequestEventDto],
    description: 'Status history, oldest first',
  })
  events: StockRequestEventDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class StockRequestPageDto {
  @ApiProperty({ type: [StockRequestDto] })
  items: StockRequestDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
