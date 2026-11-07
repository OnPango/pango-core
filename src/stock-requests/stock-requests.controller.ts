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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import {
  CreateStockRequestDto,
  FulfilStockRequestDto,
  ListStockRequestsQueryDto,
  RejectStockRequestDto,
} from './dto.js';
import { StockRequestDto, StockRequestPageDto } from './responses.js';
import { StockRequestsService } from './stock-requests.service.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 1 });
const readAccess =
  'Shows the requests of the warehouses where you hold `stock_request.read`, and ' +
  'those of your own department.';
const attention = `${requiresPermissions('stock_request.approve')} (in the request's warehouse)`;
const transitionErrors = {
  [HttpStatus.NOT_FOUND]: ['STOCK_REQUEST_NOT_FOUND'],
  [HttpStatus.CONFLICT]: ['STOCK_REQUEST_STATUS_INVALID'],
};

@ApiTags('stock-requests')
@Controller('stock-requests')
export class StockRequestsController {
  constructor(private readonly requests: StockRequestsService) {}

  @Get()
  @ApiOperation({
    summary: 'List stock requests',
    description: `Paginated, most recent first: \`{ items, total, page, pageSize }\`. ${readAccess}`,
  })
  @ApiOkResponse({ type: StockRequestPageDto })
  @ApiSession({ validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListStockRequestsQueryDto,
  ) {
    return this.requests.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a stock request',
    description: `With its lines and status history. A request you cannot read answers \`404\`. ${readAccess}`,
  })
  @idParam
  @ApiOkResponse({ type: StockRequestDto })
  @ApiSession({
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['STOCK_REQUEST_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.requests.get(auth, id);
  }

  @Post()
  @RequirePermissions('stock_request.create')
  @ApiOperation({
    summary: 'Create a stock request',
    description:
      'Your department requests products from a warehouse. The request starts ' +
      '`PENDING` and does not change stock. You must belong to an active department. ' +
      `${requiresPermissions('stock_request.create')} (in the warehouse)`,
  })
  @ApiCreatedResponse({ type: StockRequestDto })
  @ApiSession({
    permissions: ['stock_request.create'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'WAREHOUSE_INVALID',
        'DEPARTMENT_REQUIRED',
        'STOCK_REQUEST_TYPE_NOT_SUPPORTED',
        'PRODUCT_INVALID',
        'PRODUCT_DUPLICATED',
      ],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateStockRequestDto) {
    return this.requests.create(auth, dto);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stock_request.approve')
  @ApiOperation({
    summary: 'Start attending a stock request',
    description:
      '`PENDING` → `IN_PROGRESS`. Reserves the full requested quantity of every line; ' +
      'fails if the available stock is not enough (no partial attention). ' +
      attention,
  })
  @idParam
  @ApiOkResponse({ type: StockRequestDto })
  @ApiSession({
    permissions: ['stock_request.approve'],
    validation: true,
    errors: {
      ...transitionErrors,
      [HttpStatus.CONFLICT]: [
        'STOCK_REQUEST_STATUS_INVALID',
        'INSUFFICIENT_STOCK',
      ],
    },
  })
  start(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.requests.start(auth, id);
  }

  @Post(':id/fulfil')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stock_request.approve')
  @ApiOperation({
    summary: 'Confirm the consumption of a stock request',
    description:
      '`IN_PROGRESS` → `FULFILLED`. Registers the outbound movement (source ' +
      "`STOCK_REQUEST`, the request's department) that discounts the stock and feeds " +
      'the demand history, in one transaction. Fulfilling it again answers `409`. ' +
      attention,
  })
  @idParam
  @ApiOkResponse({ type: StockRequestDto })
  @ApiSession({
    permissions: ['stock_request.approve'],
    validation: true,
    errors: {
      ...transitionErrors,
      [HttpStatus.BAD_REQUEST]: [
        'LINE_INVALID',
        'PRODUCT_INVALID',
        'LOCATION_INVALID',
        'LOT_REQUIRED',
        'LOT_NOT_ALLOWED',
        'LOT_NOT_FOUND',
      ],
      [HttpStatus.CONFLICT]: [
        'STOCK_REQUEST_STATUS_INVALID',
        'INSUFFICIENT_STOCK',
        'MOVEMENT_TYPE_NOT_CONFIGURED',
      ],
    },
  })
  fulfil(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FulfilStockRequestDto,
  ) {
    return this.requests.fulfil(auth, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('stock_request.approve')
  @ApiOperation({
    summary: 'Reject a stock request',
    description:
      '`PENDING` or `IN_PROGRESS` → `REJECTED`, with a reason; releases the reservation. ' +
      attention,
  })
  @idParam
  @ApiOkResponse({ type: StockRequestDto })
  @ApiSession({
    permissions: ['stock_request.approve'],
    validation: true,
    errors: transitionErrors,
  })
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectStockRequestDto,
  ) {
    return this.requests.reject(auth, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel your stock request',
    description: '`PENDING` → `CANCELLED`. Only the user who created it.',
  })
  @idParam
  @ApiOkResponse({ type: StockRequestDto })
  @ApiSession({
    validation: true,
    errors: {
      ...transitionErrors,
      [HttpStatus.FORBIDDEN]: ['NOT_REQUESTER'],
    },
  })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.requests.cancel(auth, id);
  }
}
