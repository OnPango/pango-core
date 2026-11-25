import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';
import { SCHEMA_VERSION } from './fields.js';

export const inventoryImportErrors = {
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'IMPORT_NOT_FOUND',
      'Inventory import not found',
    ),
  notYours: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'IMPORT_NOT_YOURS',
      'Only the user who started the import can change, validate, confirm or cancel it',
    ),
  activeExists: (importId?: number) =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_ACTIVE_EXISTS',
      'The organization already has an open inventory import',
      importId === undefined ? undefined : { importId },
    ),
  idempotencyConflict: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_CONFLICT',
      'This clientRequestId was already used with a different request',
    ),
  unsupportedSchemaVersion: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'UNSUPPORTED_SCHEMA_VERSION',
      `Only schema version ${SCHEMA_VERSION} is supported`,
    ),
  mappingInvalid: (problems: string[]) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'MAPPING_INVALID',
      'The column mapping is not valid',
      { problems: problems.slice(0, 20) },
    ),
  limitExceeded: (maxRows: number) =>
    apiError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'IMPORT_LIMIT_EXCEEDED',
      `An inventory import holds at most ${maxRows} rows; split the file`,
    ),
  rowsInvalid: (problems: string[]) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'ROWS_INVALID',
      'Some rows are not in the expected format',
      { problems: problems.slice(0, 20) },
    ),
  batchTooLarge: (maxRows: number) =>
    apiError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'IMPORT_LIMIT_EXCEEDED',
      `A batch holds at most ${maxRows} rows`,
    ),
  batchConflict: (reason: string) =>
    apiError(HttpStatus.CONFLICT, 'BATCH_CONFLICT', reason),
  rowsExceedTotal: (receivedRows: number, totalRows: number) =>
    apiError(
      HttpStatus.CONFLICT,
      'ROWS_EXCEED_TOTAL',
      `The import declared ${totalRows} rows; this batch would make ${receivedRows}`,
      { receivedRows, totalRows },
    ),
  notReceiving: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_NOT_RECEIVING',
      'The import was validated and takes no more rows; to change them, start a new import',
    ),
  incomplete: (receivedRows: number, totalRows: number) =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_INCOMPLETE',
      `Send every row before validating: ${receivedRows} of ${totalRows} received`,
      { receivedRows, totalRows },
    ),
  closed: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_CLOSED',
      'The import is closed (completed, cancelled or expired)',
    ),
};
