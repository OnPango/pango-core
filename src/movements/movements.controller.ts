import {
  Body,
  Controller,
  Get,
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
  CreateMovementDto,
  ListMovementsQueryDto,
  ListMovementTypesQueryDto,
} from './dto.js';
import { MovementsService } from './movements.service.js';
import { MovementDto, MovementPageDto, MovementTypeDto } from './responses.js';

const readAccess =
  'Shows the movements of the warehouses where you hold `movement.read`.';

@ApiTags('movements')
@Controller()
export class MovementsController {
  constructor(private readonly movements: MovementsService) {}

  @Get('movement-types')
  @ApiOperation({
    summary: 'List movement types',
    description:
      'Sorted by name. With `warehouseId`, only the types you can register there.',
  })
  @ApiOkResponse({ type: [MovementTypeDto] })
  @ApiSession({ validation: true })
  listTypes(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListMovementTypesQueryDto,
  ) {
    return this.movements.listTypes(auth, query);
  }

  @Get('movements')
  @RequirePermissions('movement.read')
  @ApiOperation({
    summary: 'Movement history',
    description:
      'Paginated, most recent first: `{ items, total, page, pageSize }`. ' +
      `${readAccess} ${requiresPermissions('movement.read')}`,
  })
  @ApiOkResponse({ type: MovementPageDto })
  @ApiSession({ permissions: ['movement.read'], validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListMovementsQueryDto,
  ) {
    return this.movements.list(auth, query);
  }

  @Get('movements/:id')
  @RequirePermissions('movement.read')
  @ApiOperation({
    summary: 'Get a movement',
    description: `A movement you cannot read answers \`404\`. ${readAccess}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: MovementDto })
  @ApiSession({
    permissions: ['movement.read'],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['MOVEMENT_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.movements.get(auth, id);
  }

  @Post('movements')
  @RequirePermissions('movement.create')
  @ApiOperation({
    summary: 'Register a movement',
    description:
      'Inbound, outbound or adjustment movement, confirmed at once: stock changes in the ' +
      'same transaction and the movement cannot be edited or deleted afterwards. Stock ' +
      'never goes negative unless the organization allows it. Requires `movement.create` ' +
      'in the warehouse and a role there that allows the movement type.',
  })
  @ApiCreatedResponse({ type: MovementDto })
  @ApiSession({
    permissions: ['movement.create'],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'WAREHOUSE_INVALID',
        'MOVEMENT_TYPE_INVALID',
        'MOVEMENT_TYPE_NOT_SUPPORTED',
        'DEPARTMENT_INVALID',
        'PRODUCT_INVALID',
        'LOCATION_INVALID',
        'LOT_REQUIRED',
        'LOT_NOT_ALLOWED',
        'LOT_NOT_FOUND',
        'LINE_DIRECTION_INVALID',
      ],
      [HttpStatus.FORBIDDEN]: ['MOVEMENT_TYPE_NOT_ALLOWED'],
      [HttpStatus.CONFLICT]: ['INSUFFICIENT_STOCK'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateMovementDto) {
    return this.movements.create(auth, dto);
  }
}
