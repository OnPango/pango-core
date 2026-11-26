import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  ParseIntPipe,
  Put,
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
import {
  ListAlertsQueryDto,
  SetAlertStatusDto,
  SetReplenishmentDto,
} from './dto.js';
import { ReplenishmentService } from './replenishment.service.js';
import { AlertDto, AlertPageDto, ReplenishmentDto } from './responses.js';

const productParam = ApiParam({ name: 'productId', type: Number, example: 1 });
const warehouseParam = ApiParam({
  name: 'warehouseId',
  type: Number,
  example: 1,
});
const notFound = {
  [HttpStatus.NOT_FOUND]: ['PRODUCT_NOT_FOUND', 'WAREHOUSE_NOT_FOUND'],
};

@ApiTags('replenishment')
@Controller('products/:productId/warehouses/:warehouseId/replenishment')
export class ReplenishmentController {
  constructor(private readonly replenishment: ReplenishmentService) {}

  @Get()
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Get replenishment parameters',
    description:
      'Safety stock, reorder point, min and max stock of a product in a warehouse, ' +
      'with its stock and open alert. A product not yet enabled in the warehouse ' +
      `answers the defaults. ${requiresPermissions('stock.read')} (in the warehouse)`,
  })
  @productParam
  @warehouseParam
  @ApiOkResponse({ type: ReplenishmentDto })
  @ApiSession({
    permissions: ['stock.read'],
    validation: true,
    errors: notFound,
  })
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', ParseIntPipe) productId: number,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
  ) {
    return this.replenishment.get(auth, productId, warehouseId);
  }

  @Put()
  @RequirePermissions('replenishment.manage')
  @ApiOperation({
    summary: 'Set replenishment parameters by hand',
    description:
      'Saves the manual values, the method and the lead time, and enables the product ' +
      'in the warehouse if needed. With `FIXED_ROP` the manual values are in force; ' +
      'with `FORECAST_ROP` the safety stock and reorder point are recalculated from ' +
      'the current forecast, falling back to the manual values (`calculationIssue`). ' +
      'The alert is re-evaluated at once: one opens if ' +
      'available stock is at or below the new reorder point, and the open one resolves ' +
      `otherwise. ${requiresPermissions('replenishment.manage')} (in the warehouse)`,
  })
  @productParam
  @warehouseParam
  @ApiOkResponse({ type: ReplenishmentDto })
  @ApiSession({
    permissions: ['replenishment.manage'],
    validation: true,
    errors: {
      ...notFound,
      [HttpStatus.BAD_REQUEST]: ['REPLENISHMENT_INVALID'],
    },
  })
  set(
    @CurrentAuth() auth: AuthContext,
    @Param('productId', ParseIntPipe) productId: number,
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Body() dto: SetReplenishmentDto,
  ) {
    return this.replenishment.set(auth, productId, warehouseId, dto);
  }
}

const alertAccess =
  'Shows the alerts of the warehouses where you hold `alert.read`.';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly replenishment: ReplenishmentService) {}

  @Get()
  @RequirePermissions('alert.read')
  @ApiOperation({
    summary: 'List stock alerts',
    description:
      'Paginated, most recent first: `{ items, total, page, pageSize }`. ' +
      `${alertAccess} ${requiresPermissions('alert.read')}`,
  })
  @ApiOkResponse({ type: AlertPageDto })
  @ApiSession({ permissions: ['alert.read'], validation: true })
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListAlertsQueryDto) {
    return this.replenishment.listAlerts(auth, query);
  }

  @Get(':id')
  @RequirePermissions('alert.read')
  @ApiOperation({
    summary: 'Get a stock alert',
    description: `An alert you cannot read answers \`404\`. ${alertAccess}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: AlertDto })
  @ApiSession({
    permissions: ['alert.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['ALERT_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.replenishment.getAlert(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('alert.resolve')
  @ApiOperation({
    summary: 'Mark a stock alert attended or pending',
    description:
      'US-045: `ATTENDED` records who took charge and when; `OPEN` puts it back ' +
      'to pending. Either way it stays in force: movements keep refreshing it, it ' +
      'resolves on its own when stock recovers, and an attended alert whose ' +
      'severity rises goes back to `OPEN`. Needs `alert.resolve` in its warehouse; ' +
      `a resolved alert answers \`409 ALERT_CLOSED\`. ${requiresPermissions('alert.resolve')}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: AlertDto })
  @ApiSession({
    permissions: ['alert.resolve'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['ALERT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['ALERT_CLOSED'],
    },
  })
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetAlertStatusDto,
  ) {
    return this.replenishment.setAlertStatus(auth, id, dto);
  }
}
