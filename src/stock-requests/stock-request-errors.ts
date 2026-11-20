import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';

export const stockRequestErrors = {
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'STOCK_REQUEST_NOT_FOUND',
      'Stock request not found',
    ),
  warehouseInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'WAREHOUSE_INVALID',
      'The warehouse does not exist or is inactive',
    ),
  departmentRequired: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'DEPARTMENT_REQUIRED',
      'You must belong to an active department to request stock',
    ),
  typeNotSupported: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'STOCK_REQUEST_TYPE_NOT_SUPPORTED',
      'Only internal consumption requests are supported for now',
    ),
  productInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'PRODUCT_INVALID',
      `Line ${line}: the product does not exist or is inactive`,
    ),
  productDuplicated: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'PRODUCT_DUPLICATED',
      `Line ${line}: the product is already in another line`,
    ),
  lineInvalid: (line: number) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'LINE_INVALID',
      `Line ${line} is not a line of the request`,
    ),
  statusInvalid: (from: string, to: string) =>
    apiError(
      HttpStatus.CONFLICT,
      'STOCK_REQUEST_STATUS_INVALID',
      `A ${from} request cannot become ${to}`,
    ),
  notRequester: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'NOT_REQUESTER',
      'Only the user who created the request can cancel it',
    ),
  insufficientStock: (line: number, sku: string) =>
    apiError(
      HttpStatus.CONFLICT,
      'INSUFFICIENT_STOCK',
      `Line ${line}: not enough available stock of ${sku} in the warehouse`,
    ),
  movementTypeMissing: () =>
    apiError(
      HttpStatus.CONFLICT,
      'MOVEMENT_TYPE_NOT_CONFIGURED',
      'No outbound movement type is configured to fulfil stock requests',
    ),
};
