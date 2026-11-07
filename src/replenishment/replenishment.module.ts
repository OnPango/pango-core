import { Module } from '@nestjs/common';
import {
  AlertsController,
  ReplenishmentController,
} from './replenishment.controller.js';
import { ReplenishmentService } from './replenishment.service.js';

@Module({
  controllers: [ReplenishmentController, AlertsController],
  providers: [ReplenishmentService],
})
export class ReplenishmentModule {}
