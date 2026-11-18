import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const forecastErrors = {
  notConfigured: () =>
    apiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'FORECAST_SERVICE_NOT_CONFIGURED',
      'The forecasting service is not configured',
    ),
  runInProgress: () =>
    apiError(
      HttpStatus.CONFLICT,
      'FORECAST_RUN_IN_PROGRESS',
      'Another forecast run is in progress',
    ),
  nothingToForecast: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'NOTHING_TO_FORECAST',
      'No active product has stock movements to forecast',
    ),
  runNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'FORECAST_RUN_NOT_FOUND',
      'Forecast run not found',
    ),
  productNotFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'PRODUCT_NOT_FOUND', 'Product not found'),
  warehouseNotFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'WAREHOUSE_NOT_FOUND',
      'Warehouse not found',
    ),
};
