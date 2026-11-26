import { HttpStatus } from '@nestjs/common';
import { apiError } from '../auth/auth-errors.js';
import { IMPORT_LIMITS } from './import-format.js';

export const movementImportErrors = {
  notFound: () =>
    apiError(
      HttpStatus.NOT_FOUND,
      'IMPORT_NOT_FOUND',
      'Movement import not found',
    ),
  notUploader: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'IMPORT_NOT_YOURS',
      'Only the user who started the import can change or confirm it',
    ),
  confirmed: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_CONFIRMED',
      'The import is already confirmed',
    ),
  rowsInvalid: (problems: string[]) =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'ROWS_INVALID',
      'Some rows are not in the template format',
      { problems: problems.slice(0, 20) },
    ),
  tooManyRows: () =>
    apiError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'TOO_MANY_ROWS',
      `An import holds at most ${IMPORT_LIMITS.maxRows} rows`,
    ),
  empty: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_EMPTY',
      'Send the rows before validating',
    ),
  notValidated: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_NOT_VALIDATED',
      'Validate the import before confirming it',
    ),
  stale: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_STALE',
      'The import or the history changed since it was validated; validate it again',
    ),
  nothingToSave: () =>
    apiError(
      HttpStatus.CONFLICT,
      'IMPORT_NOTHING_VALID',
      'The import has no valid row to save',
    ),
};
