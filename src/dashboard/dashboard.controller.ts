import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ApiSession, requiresPermissions } from '../swagger/api-docs.js';
import { DashboardAlertsService } from './dashboard-alerts.service.js';
import { DashboardImportedLevelService } from './dashboard-imported-level.service.js';
import { DashboardInventoryService } from './dashboard-inventory.service.js';
import { DashboardLevelService } from './dashboard-level.service.js';
import { DashboardSummaryService } from './dashboard-summary.service.js';
import {
  DashboardAlertsQueryDto,
  DashboardLevelQueryDto,
  DashboardQueryDto,
} from './dto.js';
import {
  DashboardAlertsDto,
  DashboardInventoryDto,
  DashboardLevelDto,
  DashboardSummaryDto,
  ImportedLevelDto,
} from './responses.js';

const scope =
  'Figures cover the warehouses where you hold the permission, or only ' +
  '`warehouseId`.';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly summaryService: DashboardSummaryService,
    private readonly inventoryService: DashboardInventoryService,
    private readonly levelService: DashboardLevelService,
    private readonly importedLevelService: DashboardImportedLevelService,
    private readonly alertsService: DashboardAlertsService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Dashboard summary',
    description:
      'Key figures with their value one month earlier, the alerts in force (with ' +
      'days of cover at the current forecast) and the latest movements. Each block ' +
      `needs the read permission of its module and is \`null\` without it. ${scope}`,
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  @ApiSession({ validation: true })
  summary(@CurrentAuth() auth: AuthContext, @Query() query: DashboardQueryDto) {
    return this.summaryService.summary(auth, query);
  }

  @Get('inventory-level')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Dashboard inventory level',
    description:
      'Per day (7 or 30 days) or week (90): product-warehouses with stock and, ' +
      'with `alert.read`, in low stock, at the end of each period. Past stock is ' +
      `rebuilt from today's balances and the movements since. ${scope} ` +
      requiresPermissions('stock.read'),
  })
  @ApiOkResponse({ type: DashboardLevelDto })
  @ApiSession({ permissions: ['stock.read'], validation: true })
  level(
    @CurrentAuth() auth: AuthContext,
    @Query() query: DashboardLevelQueryDto,
  ) {
    return this.levelService.level(auth, query);
  }

  @Get('imported-inventory-level')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Dashboard inventory level from the imported history',
    description:
      'The periods of `inventory-level`, counted from the imported history ' +
      '(CU-17): per period, products with stock and, with `alert.read`, at or ' +
      "below today's reorder point, from the file's closing balance (the last " +
      'line of each day, latest import). A product-warehouse counts only before ' +
      'its first Pango movement, from which `inventory-level` counts it. Shown ' +
      `apart from Pango's figures. ${scope} ` +
      requiresPermissions('stock.read'),
  })
  @ApiOkResponse({ type: ImportedLevelDto })
  @ApiSession({ permissions: ['stock.read'], validation: true })
  importedLevel(
    @CurrentAuth() auth: AuthContext,
    @Query() query: DashboardLevelQueryDto,
  ) {
    return this.importedLevelService.level(auth, query);
  }

  @Get('inventory')
  @RequirePermissions('stock.read')
  @ApiOperation({
    summary: 'Dashboard inventory',
    description:
      'Inventory value (total and per top-level category), excess over the max ' +
      'stock or 12 weeks of forecast, stock idle for 90 days and lots expiring ' +
      `within 30 days. ${scope} ${requiresPermissions('stock.read')}`,
  })
  @ApiOkResponse({ type: DashboardInventoryDto })
  @ApiSession({ permissions: ['stock.read'], validation: true })
  inventory(
    @CurrentAuth() auth: AuthContext,
    @Query() query: DashboardQueryDto,
  ) {
    return this.inventoryService.inventory(auth, query);
  }

  @Get('alerts')
  @RequirePermissions('alert.read')
  @ApiOperation({
    summary: 'Dashboard alerts',
    description:
      'Alerts in force per warehouse and severity, and per month how many were ' +
      `raised, attended and resolved. ${scope} ${requiresPermissions('alert.read')}`,
  })
  @ApiOkResponse({ type: DashboardAlertsDto })
  @ApiSession({ permissions: ['alert.read'], validation: true })
  alerts(
    @CurrentAuth() auth: AuthContext,
    @Query() query: DashboardAlertsQueryDto,
  ) {
    return this.alertsService.alerts(auth, query);
  }
}
