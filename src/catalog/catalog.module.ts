import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { UnitsController } from './units.controller.js';

@Module({
  controllers: [ProductsController, CategoriesController, UnitsController],
  providers: [ProductsService, CategoriesService],
})
export class CatalogModule {}
