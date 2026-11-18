import { Module } from '@nestjs/common';
import { ForecastClient } from './forecast-client.js';
import { ForecastingController } from './forecasting.controller.js';
import { ForecastingService } from './forecasting.service.js';

@Module({
  controllers: [ForecastingController],
  providers: [ForecastingService, ForecastClient],
})
export class ForecastingModule {}
