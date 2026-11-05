// Response shapes for Swagger. WarehousesService declares them as its return
// types, so the compiler flags drift between the documentation and the API.
import { ApiProperty } from '@nestjs/swagger';
import { WarehouseType } from '../generated/prisma/tenant/enums.js';

export class LocationRefDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'DEFAULT' })
  code: string;
}

export class WarehouseDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'BOD-NORTE' })
  code: string;

  @ApiProperty({ example: 'Bodega Norte' })
  name: string;

  @ApiProperty({ enum: WarehouseType, enumName: 'WarehouseType' })
  type: WarehouseType;

  @ApiProperty({ type: String, nullable: true, example: null })
  address: string | null;

  @ApiProperty({
    type: LocationRefDto,
    nullable: true,
    description:
      'Created with the warehouse; stock goes there when no location is given',
  })
  defaultLocation: LocationRefDto | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
