import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import {
  PageQueryDto,
  ProductForecastsQueryDto,
  StartForecastRunDto,
} from './dto.js';
import { ForecastingService } from './forecasting.service.js';
import {
  ForecastPageDto,
  ForecastRunDto,
  ForecastRunPageDto,
} from './responses.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 1 });

@ApiTags('forecasting')
@Controller()
export class ForecastingController {
  constructor(private readonly forecasting: ForecastingService) {}

  @Post('forecast-runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('forecast.run')
  @ApiOperation({
    summary: 'Start a forecast run',
    description:
      'Sends the daily demand and stock of every active product-warehouse with ' +
      'history (or of one warehouse or product) up to the last complete Sunday to ' +
      'the forecasting service. Answers `202` with the run `RUNNING`; poll ' +
      '`GET /forecast-runs/:id` until it is `COMPLETED` or `FAILED`. One run at a ' +
      `time. ${requiresPermissions('forecast.run')}`,
  })
  @ApiAcceptedResponse({ type: ForecastRunDto })
  @ApiSession({
    permissions: ['forecast.run'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['NOTHING_TO_FORECAST'],
      [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND', 'PRODUCT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['FORECAST_RUN_IN_PROGRESS'],
      [HttpStatus.SERVICE_UNAVAILABLE]: ['FORECAST_SERVICE_NOT_CONFIGURED'],
    },
  })
  start(@CurrentAuth() auth: AuthContext, @Body() dto: StartForecastRunDto) {
    return this.forecasting.start(auth, dto);
  }

  @Get('forecast-runs')
  @RequirePermissions('forecast.read')
  @ApiOperation({
    summary: 'List forecast runs',
    description: `Most recent first. ${requiresPermissions('forecast.read')}`,
  })
  @ApiOkResponse({ type: ForecastRunPageDto })
  @ApiSession({ permissions: ['forecast.read'], validation: true })
  listRuns(@CurrentAuth() auth: AuthContext, @Query() query: PageQueryDto) {
    return this.forecasting.listRuns(auth, query);
  }

  @Get('forecast-runs/:id')
  @RequirePermissions('forecast.read')
  @ApiOperation({
    summary: 'Get a forecast run',
    description: `Status and per-series counts. ${requiresPermissions('forecast.read')}`,
  })
  @idParam
  @ApiOkResponse({ type: ForecastRunDto })
  @ApiSession({
    permissions: ['forecast.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['FORECAST_RUN_NOT_FOUND'] },
  })
  getRun(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.forecasting.getRun(auth, id);
  }

  @Get('products/:id/forecasts')
  @RequirePermissions('forecast.read')
  @ApiOperation({
    summary: 'Forecasts of a product',
    description:
      'Every forecast of the product, newest first, OK or ERROR; previous ones are ' +
      'kept. `isCurrent` marks the latest OK one per warehouse. ' +
      `${requiresPermissions('forecast.read')} (in the warehouses read); a warehouse ` +
      'where you lack it answers `404 WAREHOUSE_NOT_FOUND`.',
  })
  @idParam
  @ApiOkResponse({ type: ForecastPageDto })
  @ApiSession({
    permissions: ['forecast.read'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['PRODUCT_NOT_FOUND', 'WAREHOUSE_NOT_FOUND'],
    },
  })
  productForecasts(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ProductForecastsQueryDto,
  ) {
    return this.forecasting.productForecasts(auth, id, query);
  }
}
