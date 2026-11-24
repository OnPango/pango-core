import { Module } from '@nestjs/common';
import {
  HistoricalMovementsController,
  MovementImportsController,
} from './movement-imports.controller.js';
import { MovementImportsService } from './movement-imports.service.js';

@Module({
  controllers: [MovementImportsController, HistoricalMovementsController],
  providers: [MovementImportsService],
})
export class MovementImportsModule {}
