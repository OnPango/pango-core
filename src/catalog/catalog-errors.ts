import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const catalogErrors = {
  productNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'PRODUCT_NOT_FOUND', 'Product not found'),
  skuTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'SKU_TAKEN',
      'A product with this code already exists in the organization',
    ),
  skuLocked: () =>
    apiError(
      HttpStatus.CONFLICT,
      'SKU_LOCKED',
      'The code of a product with movements cannot be changed',
    ),
  tracksLotsLocked: () =>
    apiError(
      HttpStatus.CONFLICT,
      'TRACKS_LOTS_LOCKED',
      'Lot tracking cannot be changed once the product has movements or lots',
    ),
  categoryNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'CATEGORY_NOT_FOUND', 'Category not found'),
  categoryInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'CATEGORY_INVALID',
      'Category not found or inactive',
    ),
  stockUnitInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'STOCK_UNIT_INVALID',
      'Stock unit not found',
    ),
  categoryNameTaken: () =>
    apiError(
      HttpStatus.CONFLICT,
      'CATEGORY_NAME_TAKEN',
      'A category with this name already exists at this level',
    ),
  categoryParentInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'CATEGORY_PARENT_INVALID',
      'Parent category not found or inactive',
    ),
  categoryCycle: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'CATEGORY_CYCLE',
      'A category cannot be moved under itself or one of its subcategories',
    ),
  categoryHasActiveChildren: () =>
    apiError(
      HttpStatus.CONFLICT,
      'CATEGORY_HAS_ACTIVE_CHILDREN',
      'Deactivate its subcategories first',
    ),
};
