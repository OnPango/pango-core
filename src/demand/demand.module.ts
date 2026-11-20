import { Module } from '@nestjs/common';
import { DemandController } from './demand.controller.js';
import { DemandService } from './demand.service.js';

@Module({
  controllers: [DemandController],
  providers: [DemandService],
})
export class DemandModule {}
