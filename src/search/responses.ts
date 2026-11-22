import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';

export class SearchProductDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'TOR-001' })
  sku: string;

  @ApiProperty({ example: 'Tornillo M8' })
  name: string;

  @ApiProperty({ example: 'Tornillería', description: 'Its category' })
  category: string;
}

export class SearchProductGroupDto {
  @ApiProperty({ type: [SearchProductDto] })
  items: SearchProductDto[];

  @ApiProperty({ example: 12, description: 'Every match, not only `items`' })
  total: number;
}

export class SearchWarehouseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'BOD-CENTRAL' })
  code: string;

  @ApiProperty({ example: 'Bodega Central' })
  name: string;

  @ApiProperty({ enum: ['WAREHOUSE', 'STORE'], enumName: 'WarehouseType' })
  type: string;
}

export class SearchWarehouseGroupDto {
  @ApiProperty({ type: [SearchWarehouseDto] })
  items: SearchWarehouseDto[];

  @ApiProperty({ example: 1 })
  total: number;
}

export class SearchCategoryDto {
  @ApiProperty({ example: 3 })
  id: number;

  @ApiProperty({ example: 'Tornillería' })
  name: string;

  @ApiProperty({
    example: 'Ferretería',
    nullable: true,
    type: String,
    description: 'Name of its parent category',
  })
  parent: string | null;

  @ApiProperty({ example: true })
  isActive: boolean;
}

export class SearchCategoryGroupDto {
  @ApiProperty({ type: [SearchCategoryDto] })
  items: SearchCategoryDto[];

  @ApiProperty({ example: 1 })
  total: number;
}

export class SearchAlertProductDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'TOR-001' })
  sku: string;

  @ApiProperty({ example: 'Tornillo M8' })
  name: string;
}

export class SearchAlertDto {
  @ApiProperty({ example: 4 })
  id: number;

  @ApiProperty({ example: 2, description: '1 = lowest, 3 = nothing available' })
  severity: number;

  @ApiProperty({ type: SearchAlertProductDto })
  product: SearchAlertProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;
}

export class SearchAlertGroupDto {
  @ApiProperty({ type: [SearchAlertDto] })
  items: SearchAlertDto[];

  @ApiProperty({ example: 2 })
  total: number;
}

export class SearchUserDto {
  @ApiProperty({ example: 5 })
  id: number;

  @ApiProperty({ example: 'Ana Gómez' })
  name: string;

  @ApiProperty({ example: 'ana@empresa.co' })
  email: string;

  @ApiProperty({ example: 'Almacenista', nullable: true, type: String })
  jobTitle: string | null;

  @ApiProperty({ example: true })
  isActive: boolean;
}

export class SearchUserGroupDto {
  @ApiProperty({ type: [SearchUserDto] })
  items: SearchUserDto[];

  @ApiProperty({ example: 1 })
  total: number;
}

const group = (type: new () => object, readPermission: string) =>
  ApiProperty({
    type,
    nullable: true,
    description: `\`null\` without \`${readPermission}\``,
  });

export class SearchResultDto {
  @ApiProperty({ example: 'torn', description: 'The text that was searched' })
  query: string;

  @group(SearchProductGroupDto, 'catalog.read')
  products: SearchProductGroupDto | null;

  @group(SearchCategoryGroupDto, 'catalog.read')
  categories: SearchCategoryGroupDto | null;

  @ApiProperty({
    type: SearchWarehouseGroupDto,
    description: 'Active warehouses you can read; empty when you read none',
  })
  warehouses: SearchWarehouseGroupDto;

  @group(SearchAlertGroupDto, 'alert.read')
  alerts: SearchAlertGroupDto | null;

  @group(SearchUserGroupDto, 'user.read')
  users: SearchUserGroupDto | null;
}
