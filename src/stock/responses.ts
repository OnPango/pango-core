import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { CategoryRefDto, UnitOfMeasureDto } from '../catalog/responses.js';
import { LocationRefDto } from '../movements/responses.js';

export class StockProductDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'PRD-001' })
  sku: string;

  @ApiProperty({ example: 'Tornillo M8' })
  name: string;

  @ApiProperty({ type: UnitOfMeasureDto })
  stockUnit: UnitOfMeasureDto;

  @ApiProperty({ type: CategoryRefDto })
  category: CategoryRefDto;

  @ApiProperty({ example: true })
  tracksLots: boolean;

  @ApiProperty({
    example: true,
    description: 'Archived products are listed while they have stock',
  })
  isActive: boolean;
}

export class StockLevelDto {
  @ApiProperty({ example: 1250 })
  onHand: number;

  @ApiProperty({
    example: 0,
    description: 'Held by stock requests in attention',
  })
  reserved: number;

  @ApiProperty({
    example: 1250,
    description:
      'On hand − reserved; what the reorder point is compared against',
  })
  available: number;
}

export class StockItemDto extends StockLevelDto {
  @ApiProperty({ type: StockProductDto })
  product: StockProductDto;
}

export class StockPageDto {
  @ApiProperty({ type: [StockItemDto] })
  items: StockItemDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class LotDto {
  @ApiProperty({ example: 4 })
  id: number;

  @ApiProperty({ example: 'L-2026-11' })
  code: string;

  @ApiProperty({ example: '2026-10-01', type: String, nullable: true })
  manufactureDate: string | null;

  @ApiProperty({ example: '2027-04-30', type: String, nullable: true })
  expiryDate: string | null;
}

export class LotLocationStockDto {
  @ApiProperty({ type: LocationRefDto })
  location: LocationRefDto;

  @ApiProperty({ example: 30 })
  onHand: number;
}

export class LotStockDto extends LotDto {
  @ApiProperty({ example: 50, description: 'On hand in the warehouse' })
  onHand: number;

  @ApiProperty({
    type: [LotLocationStockDto],
    description: 'Where the lot is, by location',
  })
  locations: LotLocationStockDto[];
}

export class BalanceDto {
  @ApiProperty({ type: LocationRefDto })
  location: LocationRefDto;

  @ApiProperty({
    type: LotDto,
    nullable: true,
    description: 'Null for products that do not track lots',
  })
  lot: LotDto | null;

  @ApiProperty({ example: 30 })
  onHand: number;
}

export class ProductStockDto extends StockLevelDto {
  @ApiProperty({ type: StockProductDto })
  product: StockProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({
    type: [BalanceDto],
    description: 'Non-zero balances by location and lot',
  })
  balances: BalanceDto[];
}
