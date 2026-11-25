import { Module } from '@nestjs/common';
import { InventoryImportConfig } from './inventory-import-config.js';
import { InventoryImportsController } from './inventory-imports.controller.js';
import { InventoryImportsService } from './inventory-imports.service.js';

@Module({
  controllers: [InventoryImportsController],
  providers: [InventoryImportsService, InventoryImportConfig],
})
export class InventoryImportsModule {}
