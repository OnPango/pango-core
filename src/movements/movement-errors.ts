import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const movementErrors = {
  notFound: () =>
    apiError(HttpStatus.NOT_FOUND, 'MOVEMENT_NOT_FOUND', 'Movement not found'),
  warehouseInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'WAREHOUSE_INVALID',
      'The warehouse does not exist or is inactive',
    ),
  typeInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'MOVEMENT_TYPE_INVALID',
      'The movement type does not exist',
    ),
  typeNotSupported: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'MOVEMENT_TYPE_NOT_SUPPORTED',
      'Transfers cannot be registered yet',
    ),
  typeNotAllowed: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'MOVEMENT_TYPE_NOT_ALLOWED',
      'Your roles in this warehouse do not allow this movement type',
    ),
  departmentInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DEPARTMENT_INVALID',
      'The department does not exist or is inactive',
    ),
  productInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'PRODUCT_INVALID',
      `Line ${line}: the product does not exist or is inactive`,
    ),
  locationInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOCATION_INVALID',
      `Line ${line}: the location is not an active location of the warehouse`,
    ),
  lotRequired: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOT_REQUIRED',
      `Line ${line}: the product tracks lots; a lot code is required`,
    ),
  lotNotAllowed: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOT_NOT_ALLOWED',
      `Line ${line}: the product does not track lots`,
    ),
  lotNotFound: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOT_NOT_FOUND',
      `Line ${line}: the lot does not exist for this product`,
    ),
  directionRequired: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LINE_DIRECTION_INVALID',
      `Line ${line}: adjustment lines need a direction (INCREASE or DECREASE)`,
    ),
  directionNotAllowed: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LINE_DIRECTION_INVALID',
      `Line ${line}: only adjustment lines take a direction`,
    ),
  insufficientStock: (line: number, sku: string) =>
    apiError(
      HttpStatus.CONFLICT,
      'INSUFFICIENT_STOCK',
      `Line ${line}: not enough stock of ${sku} at that location`,
    ),
};
