import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
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
  CreateWarehouseDto,
  ListWarehousesQueryDto,
  UpdateWarehouseDto,
} from './dto.js';
import { WarehouseDto } from './responses.js';
import { WarehousesService } from './warehouses.service.js';

const idParam = ApiParam({ name: 'id', type: Number, example: 1 });

const readAccess =
  'Shows the warehouses where you hold `warehouse.read` (all of them with an ' +
  'assignment on every warehouse, or with `warehouse.manage` on every warehouse).';

@ApiTags('warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  @ApiOperation({
    summary: 'List warehouses',
    description: `Sorted by name; \`status\` defaults to \`ACTIVE\`. ${readAccess}`,
  })
  @ApiOkResponse({ type: [WarehouseDto] })
  @ApiSession({ validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListWarehousesQueryDto,
  ) {
    return this.warehouses.list(auth, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a warehouse',
    description: `A warehouse you cannot read answers \`404\`. ${readAccess}`,
  })
  @idParam
  @ApiOkResponse({ type: WarehouseDto })
  @ApiSession({
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.warehouses.get(auth, id);
  }

  @Post()
  @RequirePermissions('warehouse.manage')
  @ApiOperation({
    summary: 'Register a warehouse',
    description:
      'Storage warehouse (`WAREHOUSE`) or store (`STORE`). It is created with its ' +
      `default location (\`DEFAULT\`). ${requiresPermissions('warehouse.manage')}`,
  })
  @ApiCreatedResponse({ type: WarehouseDto })
  @ApiSession({
    permissions: ['warehouse.manage'],
    validation: true,
    errors: {
      [HttpStatus.CONFLICT]: ['WAREHOUSE_CODE_TAKEN', 'WAREHOUSE_NAME_TAKEN'],
    },
  })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateWarehouseDto) {
    return this.warehouses.create(auth, dto);
  }

  @Patch(':id')
  @RequirePermissions('warehouse.manage')
  @ApiOperation({
    summary: 'Edit a warehouse',
    description:
      'Same validations as creating. `isActive: false` closes it (warehouses are never ' +
      `deleted) and requires no stock on hand. ${requiresPermissions('warehouse.manage')}`,
  })
  @idParam
  @ApiOkResponse({ type: WarehouseDto })
  @ApiSession({
    permissions: ['warehouse.manage'],
    validation: true,
    errors: {
      [HttpStatus.NOT_FOUND]: ['WAREHOUSE_NOT_FOUND'],
      [HttpStatus.CONFLICT]: [
        'WAREHOUSE_CODE_TAKEN',
        'WAREHOUSE_NAME_TAKEN',
        'WAREHOUSE_HAS_STOCK',
      ],
    },
  })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehouses.update(auth, id, dto);
  }
}
