// Response shapes for Swagger. The catalog services declare them as their return
// types, so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';

export class UnitOfMeasureDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'EA', description: 'UN/ECE Recommendation 20 code' })
  code: string;

  @ApiProperty({ example: 'Each' })
  name: string;
}

export class CategoryRefDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'Hardware' })
  name: string;
}

export class CategoryDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'Hardware' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: null,
    description: 'null = top level',
  })
  parentId: number | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({
    example: 12,
    description: 'Products directly in this category (not its subcategories)',
  })
  productCount: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ProductDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'TOR-001' })
  sku: string;

  @ApiProperty({ example: 'Hex bolt 1/4"' })
  name: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description: string | null;

  @ApiProperty({ type: CategoryRefDto })
  category: CategoryRefDto;

  @ApiProperty({ type: UnitOfMeasureDto })
  unitOfMeasure: UnitOfMeasureDto;

  @ApiProperty({ type: Number, nullable: true, example: 5 })
  lengthCm: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 2 })
  widthCm: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  heightCm: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0.012 })
  weightKg: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0.01 })
  volumeL: number | null;

  @ApiProperty({ example: false })
  tracksLots: boolean;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class ProductPageDto {
  @ApiProperty({ type: [ProductDto] })
  items: ProductDto[];

  @ApiProperty({ example: 42, description: 'Products matching the filters' })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class WarehouseStockDto {
  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 120, description: 'On-hand quantity' })
  onHand: number;

  @ApiProperty({ example: 10 })
  safetyStock: number;

  @ApiProperty({ example: 30 })
  reorderPoint: number;

  @ApiProperty({
    enum: ['MANUAL', 'CALCULATED'],
    enumName: 'ValueSource',
    description:
      'Whether safety stock and reorder point were set by hand or computed',
  })
  valueSource: 'MANUAL' | 'CALCULATED';
}

export class ProductDetailDto extends ProductDto {
  @ApiProperty({
    example: 120,
    description: 'On-hand quantity across every warehouse',
  })
  totalOnHand: number;

  @ApiProperty({
    type: [WarehouseStockDto],
    description: 'Warehouses where the product is enabled',
  })
  warehouses: WarehouseStockDto[];

  @ApiProperty({
    example: false,
    description: 'true = the code (sku) and lot tracking can no longer change',
  })
  hasMovements: boolean;
}
