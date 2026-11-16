import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { DemandService } from './demand.service.js';
import { DemandQueryDto } from './dto.js';
import { DemandSeriesDto } from './responses.js';

@ApiTags('demand')
@Controller('products/:id/demand')
export class DemandController {
  constructor(private readonly demand: DemandService) {}

  @Get()
  @RequirePermissions('forecast.read')
  @ApiOperation({
    summary: 'Demand history of a product',
    description:
      'Demand per period (weekly or monthly, in the organization time zone), oldest ' +
      'first, with 0 for periods without demand. Demand = confirmed sales and ' +
      'internal consumption that fulfils stock requests. A product without demand ' +
      'answers an empty series with `notice: NO_HISTORY`. ' +
      `${requiresPermissions('forecast.read')} (in the warehouses read); a warehouse ` +
      'where you lack it answers `404 WAREHOUSE_NOT_FOUND`.',
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: DemandSeriesDto })
  @ApiSession({
    permissions: ['forecast.read'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['RANGE_INVALID', 'RANGE_TOO_LARGE'],
      [HttpStatus.NOT_FOUND]: ['PRODUCT_NOT_FOUND', 'WAREHOUSE_NOT_FOUND'],
    },
  })
  series(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: DemandQueryDto,
  ) {
    return this.demand.series(auth, id, query);
  }
}
