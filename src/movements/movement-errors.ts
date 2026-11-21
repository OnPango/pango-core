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
  destinationRequired: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DESTINATION_WAREHOUSE_REQUIRED',
      'Transfers need a destination warehouse',
    ),
  destinationInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DESTINATION_WAREHOUSE_INVALID',
      'The destination warehouse does not exist or is inactive',
    ),
  sameWarehouse: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'SAME_WAREHOUSE',
      'A transfer needs a destination other than its origin',
    ),
  transferFieldsNotAllowed: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'TRANSFER_FIELDS_NOT_ALLOWED',
      'Only transfers take a destination warehouse, destination locations or receiveNow',
    ),
  departmentNotAllowed: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DEPARTMENT_NOT_ALLOWED',
      'Transfers do not take a department',
    ),
  notInTransit: () =>
    apiError(
      HttpStatus.CONFLICT,
      'MOVEMENT_NOT_IN_TRANSIT',
      'Only transfers in transit can be received',
    ),
  receiptLineInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'RECEIPT_LINE_INVALID',
      `Line ${line} is not a line of the transfer, or it is repeated`,
    ),
  receivedQuantityInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'RECEIVED_QUANTITY_INVALID',
      `Line ${line}: the received quantity cannot exceed the quantity sent`,
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
  destinationLocationInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LOCATION_INVALID',
      `Line ${line}: the location is not an active location of the destination warehouse`,
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
  destinationLocationNotAllowed: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'TRANSFER_FIELDS_NOT_ALLOWED',
      `Line ${line}: only transfer lines take a destination location`,
    ),
  insufficientStock: (line: number, sku: string) =>
    apiError(
      HttpStatus.CONFLICT,
      'INSUFFICIENT_STOCK',
      `Line ${line}: not enough stock of ${sku} at that location`,
    ),
};
