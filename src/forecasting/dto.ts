import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class StartForecastRunDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Only the products of this warehouse. Omitted = every active warehouse',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Only this product. Omitted = every active product',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  productId?: number;
}

export class PageQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 25, default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ProductForecastsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'Only this warehouse. Omitted = every warehouse where you hold `forecast.read`',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;
}
