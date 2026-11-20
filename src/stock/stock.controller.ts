import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import { ListStockQueryDto, UpdateLotDto, WarehouseQueryDto } from './dto.js';
import {
  LotDto,
  LotStockDto,
  ProductStockDto,
  StockPageDto,
} from './responses.js';
import { StockService } from './stock.service.js';

const access =
  `${requiresPermissions('stock.read')} (in the warehouse). Without it the warehouse ` +
  'answers `404 WAREHOUSE_NOT_FOUND`.';
const productParam = ApiParam({ name: 'id', type: Number, example: 1 });

@ApiTags('stock')
@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get('stock')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Stock of a warehouse',
    description:
      'Products with stock in the warehouse (archived ones too), sorted by name: ' +
      '`{ items, total, page, pageSize }`. With `includeZero`, also the active ' +
      `products enabled there with no stock. ${access}`,
  })
  @ApiOkResponse({ type: StockPageDto })
  @ApiSession({
    permissions: ['stock.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND'] },
  })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListStockQueryDto) {
    return this.stock.list(auth, query);
  }

  @Get('products/:id/stock')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Stock of a product in a warehouse',
    description:
      'Totals (`onHand`, `reserved`, `available`) and the non-zero balances by ' +
      `location and lot, sorted by location and earliest expiry. ${access}`,
  })
  @productParam
  @ApiOkResponse({ type: ProductStockDto })
  @ApiSession({
    permissions: ['stock.read'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND', 'PRODUCT_NOT_FOUND'],
    },
  })
  productStock(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: WarehouseQueryDto,
  ) {
    return this.stock.productStock(auth, id, query.warehouseId);
  }

  @Get('products/:id/lots')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Lots of a product in a warehouse',
    description:
      'Only lots with stock there, earliest expiry first (lots without one last), ' +
      'with their stock by location. Products that do not track lots answer an ' +
      `empty list. ${access}`,
  })
  @productParam
  @ApiOkResponse({ type: [LotStockDto] })
  @ApiSession({
    permissions: ['stock.read'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND', 'PRODUCT_NOT_FOUND'],
    },
  })
  lots(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: WarehouseQueryDto,
  ) {
    return this.stock.lots(auth, id, query.warehouseId);
  }

  @Patch('products/:id/lots/:lotId')
  @RequirePermissions('product.manage')
  @ApiOperation({
    summary: 'Set the dates of a lot',
    description: `Manufacture and expiry dates. ${requiresPermissions('product.manage')}`,
  })
  @productParam
  @ApiParam({ name: 'lotId', type: Number, example: 4 })
  @ApiOkResponse({ type: LotDto })
  @ApiSession({
    permissions: ['product.manage'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['LOT_DATES_INVALID'],
      [HttpStatus.NOT_FOUND]: ['LOT_NOT_FOUND'],
    },
  })
  updateLot(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Param('lotId', ParseIntPipe) lotId: number,
    @Body() dto: UpdateLotDto,
  ) {
    return this.stock.updateLot(auth, id, lotId, dto);
  }
}
