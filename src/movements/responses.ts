// Response shapes for Swagger. The movements service declares them as its return
// types, so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { MovementNatureFilter } from './dto.js';

export class MovementTypeDto {
  @ApiProperty({ example: 2 })
  id: number;

  @ApiProperty({ example: 'Purchase receipt' })
  name: string;

  @ApiProperty({ enum: MovementNatureFilter, enumName: 'MovementNature' })
  nature: `${MovementNatureFilter}`;

  @ApiProperty({
    example: false,
    description: 'Confirmed movements of this type feed the demand history',
  })
  countsAsDemand: boolean;

  @ApiProperty({
    example: true,
    description: 'Seeded with the organization; cannot be deleted',
  })
  isBase: boolean;
}

export class MovementTypeRefDto {
  @ApiProperty({ example: 2 })
  id: number;

  @ApiProperty({ example: 'Purchase receipt' })
  name: string;

  @ApiProperty({ enum: MovementNatureFilter, enumName: 'MovementNature' })
  nature: `${MovementNatureFilter}`;

  @ApiProperty({ example: false })
  countsAsDemand: boolean;
}

export class MovementUserDto {
  @ApiProperty({ example: 1, description: 'Tenant user id' })
  id: number;

  @ApiProperty({ type: String, nullable: true, example: 'Ana Pérez' })
  name: string | null;
}

export class DepartmentRefDto {
  @ApiProperty({ example: 4 })
  id: number;

  @ApiProperty({ example: 'Maintenance' })
  name: string;
}

export class MovementProductDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'TOR-001' })
  sku: string;

  @ApiProperty({ example: 'Hex bolt 1/4"' })
  name: string;

  @ApiProperty({ example: 'EA', description: 'Stock unit code' })
  unit: string;
}

export class LocationRefDto {
  @ApiProperty({ example: 7 })
  id: number;

  @ApiProperty({ example: 'DEFAULT' })
  code: string;
}

export class LotRefDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'L-2026-11' })
  code: string;
}

export class MovementLineDto {
  @ApiProperty({ example: 1 })
  lineNumber: number;

  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({
    type: LocationRefDto,
    nullable: true,
    description: 'Where the stock left from; null when stock was added',
  })
  originLocation: LocationRefDto | null;

  @ApiProperty({
    type: LocationRefDto,
    nullable: true,
    description:
      'Where the stock arrived (on a transfer in transit, where it will arrive); null ' +
      'when stock was removed',
  })
  destinationLocation: LocationRefDto | null;

  @ApiProperty({ type: LotRefDto, nullable: true })
  lot: LotRefDto | null;

  @ApiProperty({ example: 12, description: 'On transfers, the quantity sent' })
  quantity: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description:
      'Transfers: what arrived at the destination (the rest was lost in transit); null ' +
      'while in transit and on other movements',
  })
  receivedQuantity: number | null;

  @ApiProperty({ example: 1500 })
  unitCost: number;
}

export class MovementDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'MV-00000001' })
  number: string;

  @ApiProperty({
    enum: ['DRAFT', 'IN_TRANSIT', 'CONFIRMED', 'VOIDED'],
    enumName: 'MovementStatus',
  })
  status: 'DRAFT' | 'IN_TRANSIT' | 'CONFIRMED' | 'VOIDED';

  @ApiProperty({
    enum: ['MANUAL', 'STOCK_REQUEST'],
    enumName: 'MovementSource',
    description: 'What originated the movement',
  })
  source: 'MANUAL' | 'STOCK_REQUEST';

  @ApiProperty({ type: MovementTypeRefDto })
  movementType: MovementTypeRefDto;

  @ApiProperty({
    type: WarehouseRefDto,
    description: 'Where it was registered; on transfers, the origin',
  })
  warehouse: WarehouseRefDto;

  @ApiProperty({
    type: WarehouseRefDto,
    nullable: true,
    description: 'Transfers: the warehouse the stock goes to; null otherwise',
  })
  destinationWarehouse: WarehouseRefDto | null;

  @ApiProperty({ type: MovementUserDto })
  registeredBy: MovementUserDto;

  @ApiProperty({
    type: MovementUserDto,
    nullable: true,
    description:
      'Transfers: who received it; null while in transit and on other movements',
  })
  receivedBy: MovementUserDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  receivedAt: Date | null;

  @ApiProperty({ type: DepartmentRefDto, nullable: true })
  department: DepartmentRefDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'FAC-1043' })
  documentRef: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  notes: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  @ApiProperty({ type: [MovementLineDto] })
  lines: MovementLineDto[];
}

export class MovementPageDto {
  @ApiProperty({ type: [MovementDto] })
  items: MovementDto[];

  @ApiProperty({ example: 42, description: 'Movements matching the filters' })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
