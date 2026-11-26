// CU-17 v1 kardex template: columns, movement codes and limits. The frontend
// reads the company's file, maps its columns onto these and sends the rows as
// JSON in batches; the API never sees the file.

/** Template v1 columns, in the template's order. */
export const V1_COLUMNS = [
  'external_movement_id',
  'line_number',
  'business_date',
  'warehouse_code',
  'sku',
  'stock_unit',
  'movement_type',
  'quantity_in',
  'quantity_out',
  'balance_after',
  'document_ref',
  'location_code',
  'lot_code',
  'unit_cost',
] as const;

export type V1Column = (typeof V1_COLUMNS)[number];

/** Cell values of one row by template column; null or '' when empty. */
export type RowValues = Record<V1Column, string | null>;

/** A row as the frontend sends it. */
export interface IncomingRow {
  /** Row of the user's file, the header being row 1. */
  rowNumber: number;
  values: RowValues;
}

/** Source event leg: ordinary lines, or one of the two legs of a transfer. */
export type Leg = 'LINE' | 'DISPATCH' | 'RECEIPT';

export interface MovementCode {
  /** Name of the base movement type it maps to (`movement_types.name`, `is_base`). */
  typeName: string;
  side: 'IN' | 'OUT';
  leg: Leg;
}

/** Standard movement codes of the template and the base type each maps to. */
export const MOVEMENT_CODES: ReadonlyMap<string, MovementCode> = new Map([
  ['OPENING_BALANCE', { typeName: 'Opening balance', side: 'IN', leg: 'LINE' }],
  [
    'PURCHASE_RECEIPT',
    { typeName: 'Purchase receipt', side: 'IN', leg: 'LINE' },
  ],
  ['SALE', { typeName: 'Sales issue', side: 'OUT', leg: 'LINE' }],
  [
    'INTERNAL_CONSUMPTION',
    { typeName: 'Consumption issue', side: 'OUT', leg: 'LINE' },
  ],
  [
    'ADJUSTMENT_IN',
    { typeName: 'Inventory adjustment', side: 'IN', leg: 'LINE' },
  ],
  [
    'ADJUSTMENT_OUT',
    { typeName: 'Inventory adjustment', side: 'OUT', leg: 'LINE' },
  ],
  ['TRANSFER_OUT', { typeName: 'Transfer', side: 'OUT', leg: 'DISPATCH' }],
  ['TRANSFER_IN', { typeName: 'Transfer', side: 'IN', leg: 'RECEIPT' }],
]);

export const IMPORT_LIMITS = {
  /** Rows per request; keeps each request under the 1 MB JSON body limit. */
  maxRowsPerBatch: 2000,
  /** Rows per import. */
  maxRows: 200_000,
  /** Characters of one value as sent; longer values reject the batch. */
  maxValueChars: 1000,
  /** Issues stored per validation (all are counted). */
  maxStoredIssues: 10_000,
};

/** Longest accepted value per column (characters, after trimming). */
export const FIELD_MAX_LENGTH: Record<V1Column, number> = {
  external_movement_id: 60,
  line_number: 10,
  business_date: 30,
  warehouse_code: 20,
  sku: 40,
  stock_unit: 10,
  movement_type: 30,
  quantity_in: 30,
  quantity_out: 30,
  balance_after: 30,
  document_ref: 60,
  location_code: 40,
  lot_code: 40,
  unit_cost: 30,
};

/**
 * A plain JSON object. A `__proto__` key in the request turns into the object's
 * prototype when the body is transformed, so it is caught here.
 */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Checks the shape of one sent row: an integer `rowNumber` ≥ 2 and `values`
 * with only template columns, each a string or null. Returns the problem, or
 * null. Keys are checked with `Object.hasOwn` against the fixed column list, so
 * no record is ever built from keys taken from the request.
 */
export function rowShapeProblem(row: unknown): string | null {
  if (!isPlainObject(row)) return 'must be an object';
  const { rowNumber, values } = row as {
    rowNumber?: unknown;
    values?: unknown;
  };
  if (!Number.isInteger(rowNumber) || (rowNumber as number) < 2) {
    return 'rowNumber must be an integer from 2 (row 1 is the header)';
  }
  if (!isPlainObject(values)) return 'values must be an object';
  const allowed = new Set<string>(V1_COLUMNS);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) return `unknown column "${key.slice(0, 40)}"`;
  }
  for (const column of V1_COLUMNS) {
    const value = Object.hasOwn(values, column)
      ? (values as Record<string, unknown>)[column]
      : null;
    if (value !== null && value !== undefined && typeof value !== 'string') {
      return `${column} must be a string or null`;
    }
    if (
      typeof value === 'string' &&
      value.length > IMPORT_LIMITS.maxValueChars
    ) {
      return `${column} is longer than ${IMPORT_LIMITS.maxValueChars} characters`;
    }
  }
  return null;
}

/** The values of a checked row, with every column present (null when absent). */
export function rowValues(values: object): RowValues {
  const result = {} as RowValues;
  for (const column of V1_COLUMNS) {
    const value: unknown = Object.hasOwn(values, column)
      ? (values as Record<string, unknown>)[column]
      : null;
    result[column] = typeof value === 'string' ? value : null;
  }
  return result;
}
