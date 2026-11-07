import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const replenishmentErrors = {
  alertNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'ALERT_NOT_FOUND', 'Alert not found'),
  productNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'PRODUCT_NOT_FOUND',
      'The product does not exist or is inactive',
    ),
  warehouseNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'WAREHOUSE_NOT_FOUND',
      'The warehouse does not exist or is inactive',
    ),
  parametersInvalid: (message: string) =>
    apiError(HttpStatus.BAD_REQUEST, 'REPLENISHMENT_INVALID', message),
};
