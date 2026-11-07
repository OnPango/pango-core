import { Module } from '@nestjs/common';
import { MovementsModule } from '../movements/movements.module.js';
import { StockRequestsController } from './stock-requests.controller.js';
import { StockRequestsService } from './stock-requests.service.js';

@Module({
  imports: [MovementsModule],
  controllers: [StockRequestsController],
  providers: [StockRequestsService],
})
export class StockRequestsModule {}
