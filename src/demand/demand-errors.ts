import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const demandErrors = {
  productNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'PRODUCT_NOT_FOUND', 'Product not found'),
  warehouseNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found',
    ),
  rangeInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'RANGE_INVALID',
      '`from` cannot be after `to`',
    ),
  rangeTooLarge: (max: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'RANGE_TOO_LARGE',
      `The range cannot have more than ${max} periods`,
    ),
};
