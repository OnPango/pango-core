// Reads the text of each cell into a typed value, or a row issue
// (docs/modules/inventary.md, "Field dictionary"). Nothing here reads the database.
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { RowValues } from './batch.js';
import { FIELDS, type InventoryField } from './fields.js';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export type Severity = 'ERROR' | 'WARNING';

export interface RowIssue {
  /** Null for an issue of the whole import. */
  rowNumber: number | null;
  field: InventoryField | null;
  severity: Severity;
  code: string;
  message: string;
  value: string | null;
}

/** A row with every present cell typed; absent cells are undefined, never zero or false. */
export interface ParsedRow {
  rowNumber: number;
  sku?: string;
  name?: string;
  category?: string;
  stockUnit?: string;
  warehouse?: string;
  tracksLots?: boolean;
  stockQuantity?: Decimal;
  unitCost?: Decimal;
  lotCode?: string;
  locationCode?: string;
  manufactureDate?: string;
  expiryDate?: string;
  warehouseType?: 'WAREHOUSE' | 'STORE';
  warehouseCode?: string;
  warehouseAddress?: string;
  description?: string;
  lengthCm?: Decimal;
  widthCm?: Decimal;
  heightCm?: Decimal;
  weightKg?: Decimal;
  volumeL?: Decimal;
}

/** Lower case without accents: how codes, names and list values are compared. */
export const fold = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const DECIMAL = /^\d+(\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LATAM_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

const TRACKING: Record<string, boolean> = { cantidad: false, lote: true };
const WAREHOUSE_TYPES: Record<string, 'WAREHOUSE' | 'STORE'> = {
  bodega: 'WAREHOUSE',
  tienda: 'STORE',
};

/** `YYYY-MM-DD` (or `DD/MM/YYYY`) of a real calendar date, as `YYYY-MM-DD`. */
export function parseDate(text: string): string | null {
  let year: number;
  let month: number;
  let day: number;
  let match = ISO_DATE.exec(text);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = LATAM_DATE.exec(text);
    if (!match) return null;
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

const invalid = (
  rowNumber: number,
  field: InventoryField,
  message: string,
  value: string,
): RowIssue => ({
  rowNumber,
  field,
  severity: 'ERROR',
  code: 'INVALID_VALUE',
  message,
  value: value.slice(0, 200),
});

/**
 * Types every present cell of a row. A value that does not fit its field is an
 * `INVALID_VALUE` issue and stays absent; required fields are checked later.
 */
export function parseRow(
  rowNumber: number,
  values: RowValues,
): { row: ParsedRow; issues: RowIssue[] } {
  const row: ParsedRow = { rowNumber };
  const issues: RowIssue[] = [];
  const typed = row as unknown as Record<string, unknown>;

  for (const field of FIELDS) {
    const raw = values[field.key];
    if (raw === undefined || raw === null) continue;
    const text = raw.trim();
    if (text === '') continue;

    switch (field.type) {
      case 'text':
      case 'unit':
        if (text.length > field.maxLength) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: at most ${field.maxLength} characters`,
              text,
            ),
          );
        } else {
          typed[field.key] = text;
        }
        break;
      case 'decimal': {
        if (!DECIMAL.test(text)) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: a number with "." as decimal separator and no thousands separator`,
              text,
            ),
          );
          break;
        }
        const decimals = text.split('.')[1]?.length ?? 0;
        const value = new Decimal(text);
        if (decimals > field.maxDecimals) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: at most ${field.maxDecimals} decimals`,
              text,
            ),
          );
        } else if (value.lt(field.min) || value.gt(field.max)) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: from ${field.min} to ${field.max}`,
              text,
            ),
          );
        } else {
          typed[field.key] = value;
        }
        break;
      }
      case 'date': {
        const date = parseDate(text);
        if (date === null) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: a date as YYYY-MM-DD`,
              text,
            ),
          );
        } else {
          typed[field.key] = date;
        }
        break;
      }
      case 'list': {
        const options = field.key === 'tracksLots' ? TRACKING : WAREHOUSE_TYPES;
        const value = options[fold(text)];
        if (value === undefined) {
          issues.push(
            invalid(
              rowNumber,
              field.key,
              `${field.label}: ${field.values.join(' or ')}`,
              text,
            ),
          );
        } else {
          typed[field.key] = value;
        }
        break;
      }
    }
  }
  return { row, issues };
}
