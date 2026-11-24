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
import { PageQueryDto } from '../forecasting/dto.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import {
  AppendImportRowsDto,
  ConfirmMovementImportDto,
  CreateMovementImportDto,
  HistoricalMovementsQueryDto,
  ImportIssuesQueryDto,
} from './dto.js';
import { IMPORT_LIMITS } from './import-format.js';
import { MovementImportsService } from './movement-imports.service.js';
import {
  AppendRowsResultDto,
  HistoricalMovementPageDto,
  ImportBalancePageDto,
  MovementImportDto,
  MovementImportReportDto,
} from './responses.js';

const PERMISSION = 'movement.import';
const OWN =
  'Only the user who started the import can send rows, validate or confirm it ' +
  '(`403 IMPORT_NOT_YOURS`).';
const READ_ACCESS =
  'You see an import you started, or one whose rows are all in warehouses where ' +
  'you hold `movement.import`; otherwise it answers `404 IMPORT_NOT_FOUND`.';
const ISOLATED =
  'Imported history never changes stock, costs, alerts or the catalog.';

@ApiTags('movement-imports')
@Controller('movement-imports')
export class MovementImportsController {
  constructor(private readonly imports: MovementImportsService) {}

  @Post()
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'Start a history import',
    description:
      'CU-17. The frontend maps the company file onto the v1 template, starts an ' +
      'import, sends its rows in batches, validates and confirms. ' +
      `${ISOLATED} ${requiresPermissions(PERMISSION)}.`,
  })
  @ApiCreatedResponse({ type: MovementImportDto })
  @ApiSession({ permissions: [PERMISSION], validation: true })
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreateMovementImportDto,
  ) {
    return this.imports.create(auth, dto);
  }

  @Post(':id/rows')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'Send a batch of rows',
    description:
      `Up to ${IMPORT_LIMITS.maxRowsPerBatch} rows per request and ` +
      `${IMPORT_LIMITS.maxRows} per import. Values are strings in the template ` +
      'format (dates YYYY-MM-DD, decimals with "."). A row number sent again ' +
      'replaces that row, so retrying a batch is safe. Sending rows reopens a ' +
      `validated import. ${OWN}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: AppendRowsResultDto })
  @ApiSession({
    permissions: [PERMISSION],
    validation: true,
    errors: {
      [HttpStatus.BAD_REQUEST]: ['ROWS_INVALID'],
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['IMPORT_CONFIRMED'],
      [HttpStatus.PAYLOAD_TOO_LARGE]: ['TOO_MANY_ROWS'],
    },
  })
  appendRows(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AppendImportRowsDto,
  ) {
    return this.imports.appendRows(auth, id, dto);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'Validate the rows and preview the import',
    description:
      "Checks every row against the organization's data, reading only: SKUs, " +
      'warehouses where you may import, locations, lots, units, movement types your ' +
      'roles allow, repeated keys, lines already imported, documents and balances. ' +
      'Answers the import (with a new `revision`) and the first page of issues. ' +
      OWN,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: MovementImportReportDto })
  @ApiSession({
    permissions: [PERMISSION],
    errors: {
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: ['IMPORT_CONFIRMED', 'IMPORT_EMPTY'],
    },
  })
  validate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.imports.validate(auth, id);
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'Save the valid rows into the history',
    description:
      'Saves the valid rows of the validated `revision` into the imported history; ' +
      'invalid rows and lines already imported are left out. Confirming again ' +
      'answers the first result. If the import or the history changed since the ' +
      `validation, answers \`409 IMPORT_STALE\`: validate again. ${ISOLATED} ${OWN}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: MovementImportDto })
  @ApiSession({
    permissions: [PERMISSION],
    validation: true,
    errors: {
      [HttpStatus.FORBIDDEN]: ['IMPORT_NOT_YOURS'],
      [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'],
      [HttpStatus.CONFLICT]: [
        'IMPORT_NOT_VALIDATED',
        'IMPORT_STALE',
        'IMPORT_NOTHING_VALID',
      ],
    },
  })
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmMovementImportDto,
  ) {
    return this.imports.confirm(auth, id, dto);
  }

  @Get(':id')
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'An import and its issues',
    description:
      'The import and a page of the issues of its last validation, by row. Filter ' +
      `by \`severity\` or \`code\`. ${READ_ACCESS}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: MovementImportReportDto })
  @ApiSession({
    permissions: [PERMISSION],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'] },
  })
  report(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ImportIssuesQueryDto,
  ) {
    return this.imports.report(auth, id, query);
  }

  @Get(':id/balances')
  @RequirePermissions(PERMISSION)
  @ApiOperation({
    summary: 'Historical balances and demand of an import',
    description:
      'Per product and warehouse, from the valid rows of the last validation: how ' +
      'many there are, the closing balance the file gives (null when it sets no ' +
      `starting balance) and the demand. Sorted by warehouse code and SKU. ${READ_ACCESS}`,
  })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiOkResponse({ type: ImportBalancePageDto })
  @ApiSession({
    permissions: [PERMISSION],
    validation: true,
    errors: { [HttpStatus.NOT_FOUND]: ['IMPORT_NOT_FOUND'] },
  })
  balances(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PageQueryDto,
  ) {
    return this.imports.balances(auth, id, query);
  }
}

@ApiTags('movement-imports')
@Controller('historical-movements')
export class HistoricalMovementsController {
  constructor(private readonly imports: MovementImportsService) {}

  @Get()
  @RequirePermissions('movement.read')
  @ApiOperation({
    summary: 'Imported movement history',
    description:
      "The company's history before Pango, newest first, apart from Pango's " +
      'movements. `afterCutover` marks lines on or after the first Pango movement ' +
      'of their product in their warehouse: they are shown but not counted in ' +
      `demand or the forecast. ${ISOLATED} ${requiresPermissions('movement.read')} ` +
      '(only the warehouses where you hold it).',
  })
  @ApiOkResponse({ type: HistoricalMovementPageDto })
  @ApiSession({ permissions: ['movement.read'], validation: true })
  list(
    @CurrentAuth() auth: AuthContext,
    @Query() query: HistoricalMovementsQueryDto,
  ) {
    return this.imports.history(auth, query);
  }
}
