import { Prisma } from '../generated/prisma/tenant/client.js';
import {
  FIELD_MAX_LENGTH,
  type IncomingRow,
  MOVEMENT_CODES,
  type MovementCode,
  V1_COLUMNS,
  type V1Column,
} from './import-format.js';

type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

/** Largest absolute value of a `Decimal(14, 4)` column. */
const MAX_DECIMAL = new Decimal('9999999999.9999');

export type IssueSeverity = 'ERROR' | 'WARNING';

export interface Issue {
  /** Null for a problem of the whole import. */
  rowNumber: number | null;
  field: V1Column | null;
  severity: IssueSeverity;
  code: string;
  message: string;
  value?: string;
}

/** A row with every field read and typed; missing fields failed to parse. */
export interface ParsedRow {
  rowNumber: number;
  /** Values by template column as sent, trimmed ('' when empty). */
  source: Record<V1Column, string>;
  externalMovementId?: string;
  lineNumber?: number;
  /** YYYY-MM-DD. */
  businessDate?: string;
  warehouseCode?: string;
  sku?: string;
  stockUnit?: string;
  movementCode?: string;
  code?: MovementCode;
  quantityIn?: Decimal;
  quantityOut?: Decimal;
  balanceAfter?: Decimal;
  unitCost?: Decimal;
  documentRef?: string;
  locationCode?: string;
  lotCode?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A real calendar date in 1900–9999, as YYYY-MM-DD. */
function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** YYYY-MM-DD; DD/MM/YYYY (Spanish locales) is accepted too. */
export function textDate(text: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDate(+iso[1], +iso[2], +iso[3]);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (dmy) return calendarDate(+dmy[3], +dmy[2], +dmy[1]);
  return null;
}

/** A decimal with a point, no grouping, at most 4 decimals and 10 integer digits. */
export function parseDecimal(text: string): Decimal | null {
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = new Decimal(text);
  if (value.decimalPlaces() > 4 || value.abs().gt(MAX_DECIMAL)) return null;
  return value;
}

/**
 * Reads every row through the fixed v1 columns. Field-level problems become
 * issues; references (SKU, warehouse…) are resolved by `validate`.
 */
export function normalize(incoming: IncomingRow[]): {
  rows: ParsedRow[];
  issues: Issue[];
} {
  const issues: Issue[] = [];
  const rows: ParsedRow[] = [];

  for (const { rowNumber, values } of incoming) {
    const source = {} as Record<V1Column, string>;
    for (const column of V1_COLUMNS) {
      source[column] = (values[column] ?? '').trim();
    }
    const row: ParsedRow = { rowNumber, source };
    rows.push(row);

    const issue = (
      field: V1Column,
      code: string,
      message: string,
      severity: IssueSeverity = 'ERROR',
    ) =>
      issues.push({
        rowNumber,
        field,
        severity,
        code,
        message,
        value: source[field] || undefined,
      });

    // Usable values: over-long ones are reported and not read.
    const usable = new Set<V1Column>();
    for (const column of V1_COLUMNS) {
      if (source[column] === '') continue;
      if (source[column].length > FIELD_MAX_LENGTH[column]) {
        issue(
          column,
          'FIELD_TOO_LONG',
          `At most ${FIELD_MAX_LENGTH[column]} characters`,
        );
      } else usable.add(column);
    }
    const tooLong = (column: V1Column) =>
      source[column] !== '' && !usable.has(column);
    const text = (column: V1Column) =>
      usable.has(column) ? source[column] : undefined;
    const required = (column: V1Column) => {
      const value = text(column);
      if (value === undefined && !tooLong(column)) {
        issue(column, 'REQUIRED', 'Required');
      }
      return value;
    };

    row.externalMovementId = required('external_movement_id');

    const line = required('line_number');
    if (line !== undefined) {
      if (/^\d{1,6}$/.test(line) && Number(line) >= 1) {
        row.lineNumber = Number(line);
      } else {
        issue(
          'line_number',
          'INVALID_NUMBER',
          'A whole number from 1 to 999999',
        );
      }
    }

    const date = required('business_date');
    if (date !== undefined) {
      const parsed = textDate(date);
      if (parsed) row.businessDate = parsed;
      else issue('business_date', 'INVALID_DATE', 'A real date as YYYY-MM-DD');
    }

    row.warehouseCode = required('warehouse_code');
    row.sku = required('sku');
    row.stockUnit = text('stock_unit');
    row.documentRef = text('document_ref');
    row.locationCode = text('location_code');
    row.lotCode = text('lot_code');

    const movement = required('movement_type');
    if (movement !== undefined) {
      const code = MOVEMENT_CODES.get(movement.toUpperCase());
      if (code) {
        row.movementCode = movement.toUpperCase();
        row.code = code;
      } else {
        issue(
          'movement_type',
          'UNKNOWN_MOVEMENT_TYPE',
          `One of ${[...MOVEMENT_CODES.keys()].join(', ')}`,
        );
      }
    }

    const decimal = (column: V1Column, allowNegative: boolean) => {
      const value = text(column);
      if (value === undefined) return undefined;
      const parsed = parseDecimal(value);
      if (!parsed || (!allowNegative && parsed.isNegative())) {
        issue(
          column,
          'INVALID_NUMBER',
          `${allowNegative ? 'A' : 'A non-negative'} number with "." as decimal ` +
            'separator, at most 4 decimals and no thousands separators',
        );
        return undefined;
      }
      return parsed;
    };
    const quantityIn = decimal('quantity_in', false);
    const quantityOut = decimal('quantity_out', false);
    row.balanceAfter = decimal('balance_after', true);
    row.unitCost = decimal('unit_cost', false);

    if (row.code) {
      const [side, other] =
        row.code.side === 'IN'
          ? (['quantity_in', 'quantity_out'] as const)
          : (['quantity_out', 'quantity_in'] as const);
      const value = side === 'quantity_in' ? quantityIn : quantityOut;
      if (usable.has(other)) {
        issue(
          other,
          'QUANTITY_SIDE',
          `${row.movementCode} takes its quantity in ${side} only`,
        );
      } else if (!usable.has(side) && !tooLong(side)) {
        issue(side, 'REQUIRED', `${row.movementCode} needs ${side}`);
      } else if (value) {
        if (value.isZero() && row.movementCode !== 'OPENING_BALANCE') {
          issue(side, 'INVALID_QUANTITY', 'Must be greater than 0');
        } else if (side === 'quantity_in') row.quantityIn = value;
        else row.quantityOut = value;
      }
    }
  }
  return { rows, issues };
}
