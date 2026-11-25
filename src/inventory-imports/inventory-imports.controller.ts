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
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import {
  AppendInventoryRowsDto,
  ConfirmInventoryImportDto,
  CreateInventoryImportDto,
  ListInventoryImportIssuesQueryDto,
  ListInventoryImportRowsQueryDto,
  ListInventoryImportsQueryDto,
} from './dto.js';
import { INVENTORY_IMPORT } from './inventory-import-access.js';
import { InventoryImportsService } from './inventory-imports.service.js';
import {
  AppendInventoryRowsResultDto,
  InventoryImportDto,
  InventoryImportFieldsDto,
  InventoryImportIssuePageDto,
  InventoryImportPageDto,
  InventoryImportReportDto,
  InventoryImportRowPageDto,
} from './responses.js';

const OWN =
  'Only the user who started the import can change it (`403 IMPORT_NOT_YOURS`).';
const VISIBLE =
  'You see the imports you started; others only if you hold `inventory.import` ' +
  'in every warehouse they touch (the Owner sees all). Otherwise `404 IMPORT_NOT_FOUND`.';

@ApiTags('inventory-imports')
@Controller('inventory-imports')
export class InventoryImportsController {
  constructor(private readonly imports: InventoryImportsService) {}

  @Get('fields')
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Field dictionary and limits of the inventory template',
    description:
      'The 21 fields with their rules, the units of measure with the accepted ' +
      'ways of writing them, and the effective limits. The frontend reads it ' +
      `instead of hard-coding them. ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiOkResponse({ type: InventoryImportFieldsDto })
  @ApiSession({ permissions: [INVENTORY_IMPORT] })
  fields(@CurrentAuth() auth: AuthContext) {
    return this.imports.fields(auth);
  }

  @Post()
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Start an inventory import',
    description:
      'An opening of current stock from one file (docs/modules/inventary.md). ' +
      'Answers 201 with the new import, or 200 with the same import when the ' +
      'same `clientRequestId` and body are sent again. One open import per ' +
      `organization. ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiCreatedResponse({ type: InventoryImportDto })
  @ApiOkResponse({
    type: InventoryImportDto,
    description: 'A repeated request',
  })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: [
        'UNSUPPORTED_SCHEMA_VERSION',
        'MAPPING_INVALID',
      ],
      [HttpStatus.CONFLICT]: ['IDEMPOTENCY_CONFLICT', 'IMPORT_ACTIVE_EXISTS'],
      [HttpStatus.PAYLOAD_TOO_LARGE]: ['IMPORT_LIMIT_EXCEEDED'],
    },
  })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateInventoryImportDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { import: record, replayed } = await this.imports.create(auth, dto);
    if (replayed) response.status(HttpStatus.OK);
    return record;
  }

  @Get()
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'List inventory imports',
    description: `Newest first. ${VISIBLE} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiOkResponse({ type: InventoryImportPageDto })
  @ApiSession({ permissions: [INVENTORY_IMPORT], validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ListInventoryImportsQueryDto,
  ) {
    return this.imports.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Get an inventory import',
    description: `Its status, summary and result. ${VISIBLE} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    errors: { [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'] },
  })
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseIntPipe) id: number) {
    return this.imports.get(auth, id);
  }

  @Post(':id/rows')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Send a batch of rows',
    description:
      "Values travel as the cells' text (or null); their contents are checked " +
      'by validation, not here. Retrying the same batch (same number, same rows) ' +
      'answers the first result with `replayed: true`. Only while `RECEIVING`; ' +
      `the body must fit in 1 MB. ${OWN} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: AppendInventoryRowsResultDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['ROWS_INVALID'],
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: [
        'BATCH_CONFLICT',
        'ROWS_EXCEED_TOTAL',
        'IMPORT_NOT_RECEIVING',
        'IMPORT_CLOSED',
      ],
      [HttpStatus.PAYLOAD_TOO_LARGE]: ['IMPORT_LIMIT_EXCEEDED'],
    },
  })
  appendRows(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AppendInventoryRowsDto,
  ) {
    return this.imports.appendRows(auth, id, dto);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Validate every row and preview the import',
    description:
      "Checks every row against the organization's current data (nothing " +
      'definitive is written) and answers the import, with a new `revision`, ' +
      'status `READY` (no errors) or `INVALID`, its summary and the first page ' +
      'of issues. Needs every declared row; can run again while the import is ' +
      `open. ${OWN} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportReportDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    errors: {
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['IMPORT_INCOMPLETE', 'IMPORT_CLOSED'],
    },
  })
  validate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.imports.validate(auth, id);
  }

  @Get(':id/rows')
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Preview rows of an inventory import',
    description:
      'The rows as the last validation resolved them (entities, whether they ' +
      'would be created, location, lot, unit, quantity, cost), by row number. ' +
      '`PENDING` with only the SKU before validation; empty once the import ' +
      `closes. ${VISIBLE} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportRowPageDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'] },
  })
  previewRows(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListInventoryImportRowsQueryDto,
  ) {
    return this.imports.rowPage(auth, id, query);
  }

  @Get(':id/issues')
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Errors and warnings of an inventory import',
    description:
      'The issues of the last validation, by row, with the source column of ' +
      'each field. All are counted; the first 10,000 are listed. ' +
      `${VISIBLE} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportIssuePageDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'] },
  })
  issues(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListInventoryImportIssuesQueryDto,
  ) {
    return this.imports.issuePage(auth, id, query);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Confirm the validated revision',
    description:
      'Writes everything in one transaction, or nothing: re-validates under ' +
      'locks, then creates the new categories, warehouses (with the creator ' +
      'assigned), products and lots and records the stock as "Opening balance" ' +
      'movements. Answers the import with its `result`; a repeated confirmation ' +
      'answers the same result. `409 IMPORT_STALE` when the revision is not the ' +
      `last one or something changed: validate again. ${OWN} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    validation: true,
    errors: {
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: [
        'IMPORT_NOT_READY',
        'IMPORT_STALE',
        'IMPORT_CLOSED',
      ],
    },
  })
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmInventoryImportDto,
  ) {
    return this.imports.confirm(auth, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(INVENTORY_IMPORT)
  @ApiOperation({
    summary: 'Cancel an open inventory import',
    description:
      'Deletes its staged rows. Cancelling a cancelled or expired import answers ' +
      `it as it is. ${OWN} ${requiresPermissions(INVENTORY_IMPORT)}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 15 })
  @ApiOkResponse({ type: InventoryImportDto })
  @ApiSession({
    permissions: [INVENTORY_IMPORT],
    errors: {
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['IMPORT_CLOSED'],
    },
  })
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.imports.cancel(auth, id);
  }
}
