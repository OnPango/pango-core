import { Module } from '@nestjs/common';
import { DashboardAlertsService } from './dashboard-alerts.service.js';
import { DashboardInventoryService } from './dashboard-inventory.service.js';
import { DashboardLevelService } from './dashboard-level.service.js';
import { DashboardSummaryService } from './dashboard-summary.service.js';
import { DashboardController } from './dashboard.controller.js';

// US-047: read-only figures for the dashboard, one service per tab.
@Module({
  controllers: [DashboardController],
  providers: [
    DashboardSummaryService,
    DashboardInventoryService,
    DashboardLevelService,
    DashboardAlertsService,
  ],
})
export class DashboardModule {}
