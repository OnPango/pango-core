import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const stockErrors = {
  warehouseNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found',
    ),
  productNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'PRODUCT_NOT_FOUND', 'Product not found'),
  lotNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'LOT_NOT_FOUND', 'Lot not found'),
  lotDatesInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOT_DATES_INVALID',
      'The expiry date cannot be before the manufacture date',
    ),
};
