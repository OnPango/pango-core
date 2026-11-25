// Shape of a batch of rows (docs/modules/inventary.md, `POST /inventory-imports/:id/rows`).
// Only the structure is checked here; cell contents are checked by validation, so
// a bad cell becomes a row issue instead of rejecting the batch.
import { FIELD_KEYS, type InventoryField } from './fields.js';

/** Cell values of a row by field key, as sent: text, or null for an empty cell. */
export type RowValues = Partial<Record<InventoryField, string | null>>;

export interface IncomingRow {
  /** Row of the user's file, the header being row 1. */
  rowNumber: number;
  values: RowValues;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Why one sent row is not a row, or null when its shape is right. */
function rowProblem(
  row: unknown,
  maxValueChars: number,
  maxRowChars: number,
): string | null {
  if (!isPlainObject(row)) return 'must be { rowNumber, values }';
  const extra = Object.keys(row).filter(
    (k) => k !== 'rowNumber' && k !== 'values',
  );
  if (extra.length > 0) return `unknown key ${extra[0]}`;
  const { rowNumber, values } = row;
  if (
    !Number.isInteger(rowNumber) ||
    (rowNumber as number) < 2 ||
    (rowNumber as number) > 2_147_483_647
  ) {
    return 'rowNumber must be an integer from 2 (row 1 is the header)';
  }
  if (!isPlainObject(values)) return 'values must be an object';
  let total = 0;
  for (const key of Object.keys(values)) {
    if (!FIELD_KEYS.has(key))
      return `values.${key} is not a field of the template`;
    const value = values[key];
    if (value !== null && typeof value !== 'string') {
      return `values.${key} must be text or null`;
    }
    if (typeof value === 'string' && value.length > maxValueChars) {
      return `values.${key} is longer than ${maxValueChars} characters`;
    }
    total += typeof value === 'string' ? value.length : 0;
  }
  if (total > maxRowChars) {
    return `the values add up to more than ${maxRowChars} characters`;
  }
  return null;
}

/**
 * The rows of a batch, or the problems that reject it whole (structure only:
 * unknown keys, row numbers, value types, repeated rows in the batch).
 */
export function checkBatchRows(
  sent: unknown[],
  maxValueChars: number,
  maxRowChars: number,
): { rows: IncomingRow[]; problems: string[] } {
  const rows: IncomingRow[] = [];
  const problems: string[] = [];
  const seen = new Set<number>();
  sent.forEach((row, index) => {
    const problem = rowProblem(row, maxValueChars, maxRowChars);
    if (problem) {
      problems.push(`rows[${index}]: ${problem}`);
      return;
    }
    const { rowNumber, values } = row as {
      rowNumber: number;
      values: Record<string, string | null>;
    };
    if (seen.has(rowNumber)) {
      problems.push(`rows[${index}]: rowNumber ${rowNumber} is repeated`);
      return;
    }
    seen.add(rowNumber);
    // Copy only the known keys, so nothing else is ever stored.
    const copy: RowValues = {};
    for (const key of Object.keys(values)) {
      copy[key as InventoryField] = values[key];
    }
    rows.push({ rowNumber, values: copy });
  });
  return { rows, problems };
}
