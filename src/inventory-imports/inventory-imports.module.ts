import { Module } from '@nestjs/common';
import { MovementsModule } from '../movements/movements.module.js';
import { InventoryImportConfig } from './inventory-import-config.js';
import { InventoryImportsController } from './inventory-imports.controller.js';
import { InventoryImportsService } from './inventory-imports.service.js';

@Module({
  imports: [MovementsModule],
  controllers: [InventoryImportsController],
  providers: [InventoryImportsService, InventoryImportConfig],
})
export class InventoryImportsModule {}
