import { Prisma } from '../generated/prisma/tenant/client.js';
import type { Leg } from './import-format.js';
import type { Issue, ParsedRow } from './normalize.js';

type Decimal = Prisma.Decimal;

/** Code reserved for a warehouse's default location. */
export const DEFAULT_LOCATION = 'DEFAULT';

/** Tenant data the rows are resolved against; codes are keyed lower-case. */
export interface Lookups {
  /** Only warehouses where the user may import. */
  warehouses: Map<string, { id: number; code: string }>;
  products: Map<
    string,
    { id: number; sku: string; tracksLots: boolean; unitCode: string }
  >;
  /** Key `${warehouseId}:${code}`. */
  locations: Map<string, number>;
  /** Key `${productId}:${code}`. */
  lots: Map<string, number>;
  /** Base movement types by name. */
  types: Map<string, { id: number; countsAsDemand: boolean }>;
  /** Movement types the user may import, per warehouse. */
  allowedTypes: Map<number, Set<number>>;
}

export interface ValidateOptions {
  /** Today in the organization's time zone, YYYY-MM-DD. */
  today: string;
  /**
   * Lines already in the history with one of the rows' source keys (see
   * `sourceKey`), by key, as `historyFingerprint`.
   */
  existing: Map<string, string>;
}

export type RowStatus = 'VALID' | 'INVALID' | 'DUPLICATE';

export interface ValidatedRow extends ParsedRow {
  status: RowStatus;
  leg?: Leg;
  movementTypeId?: number;
  countsAsDemand?: boolean;
  warehouseId?: number;
  productId?: number;
  locationId?: number;
  lotId?: number;
  runningBalance?: Decimal;
  demandQuantity: Decimal;
  /** The same line is already in the history: counted, not saved again. */
  alreadyImported?: boolean;
}

const lower = (value: string) => value.toLowerCase();

const digitsOnly = (value: string) => /^\d+$/.test(value);

function excelHint(code: string): string {
  return digitsOnly(code)
    ? '. If the file went through Excel as CSV, leading zeros may have been removed'
    : '';
}

/** Key of a source event within a namespace: the same key twice is the same event. */
export function sourceKey(key: {
  externalMovementId?: string;
  lineNumber?: number;
  leg?: Leg;
}): string | null {
  if (!key.externalMovementId || !key.lineNumber || !key.leg) return null;
  return `${key.externalMovementId}\u0000${key.lineNumber}\u0000${key.leg}`;
}

/** What makes two imports of one source line the same line. */
export function historyFingerprint(line: {
  businessDate: string;
  warehouseId: number;
  productId: number;
  movementCode: string;
  quantityIn: Decimal | null;
  quantityOut: Decimal | null;
  locationCode: string | null;
  lotCode: string | null;
  unitCost: Decimal | null;
}): string {
  return JSON.stringify([
    line.businessDate,
    line.warehouseId,
    line.productId,
    line.movementCode,
    line.quantityIn?.toString() ?? null,
    line.quantityOut?.toString() ?? null,
    lower(line.locationCode ?? DEFAULT_LOCATION),
    line.lotCode ? lower(line.lotCode) : null,
    line.unitCost?.toString() ?? null,
  ]);
}

/** Business content compared between copies of one source key. */
function fingerprint(row: ValidatedRow): string {
  const s = row.source;
  return JSON.stringify([
    row.businessDate ?? s.business_date,
    lower(row.warehouseCode ?? s.warehouse_code),
    lower(row.sku ?? s.sku),
    row.movementCode ?? s.movement_type.toUpperCase(),
    row.quantityIn?.toString() ?? s.quantity_in,
    row.quantityOut?.toString() ?? s.quantity_out,
    lower(row.locationCode ?? s.location_code),
    lower(row.lotCode ?? s.lot_code),
    row.unitCost?.toString() ?? s.unit_cost,
  ]);
}

/**
 * Resolves every row against the tenant, then checks repeated source keys,
 * document consistency and the balances the file reports. Pure: the caller
 * loads `lookups` from the rows' codes.
 */
export function validate(
  parsed: ParsedRow[],
  parseIssues: Issue[],
  lookups: Lookups,
  options: ValidateOptions,
): { rows: ValidatedRow[]; issues: Issue[] } {
  const issues = [...parseIssues];
  const errors = new Set<number>();
  for (const i of parseIssues) {
    if (i.severity === 'ERROR' && i.rowNumber !== null) errors.add(i.rowNumber);
  }
  const add = (
    row: ValidatedRow,
    entry: Omit<Issue, 'rowNumber' | 'value'>,
  ) => {
    issues.push({
      ...entry,
      rowNumber: row.rowNumber,
      value: entry.field ? row.source[entry.field] || undefined : undefined,
    });
    if (entry.severity === 'ERROR') errors.add(row.rowNumber);
  };

  const rows: ValidatedRow[] = parsed.map((p) => ({
    ...p,
    status: 'VALID',
    leg: p.code?.leg,
    demandQuantity: new Prisma.Decimal(0),
  }));

  // References.
  for (const row of rows) {
    if (row.businessDate && row.businessDate > options.today) {
      add(row, {
        field: 'business_date',
        severity: 'ERROR',
        code: 'DATE_IN_FUTURE',
        message: 'History cannot be dated after today',
      });
    }
    const warehouse = row.warehouseCode
      ? lookups.warehouses.get(lower(row.warehouseCode))
      : undefined;
    if (row.warehouseCode && !warehouse) {
      add(row, {
        field: 'warehouse_code',
        severity: 'ERROR',
        code: 'UNKNOWN_WAREHOUSE',
        message:
          'No warehouse with this code where you may import' +
          excelHint(row.warehouseCode),
      });
    }
    row.warehouseId = warehouse?.id;

    const product = row.sku ? lookups.products.get(lower(row.sku)) : undefined;
    if (row.sku && !product) {
      add(row, {
        field: 'sku',
        severity: 'ERROR',
        code: 'UNKNOWN_SKU',
        message: 'No product with this SKU' + excelHint(row.sku),
      });
    }
    row.productId = product?.id;

    if (row.code) {
      const type = lookups.types.get(row.code.typeName);
      if (!type) {
        add(row, {
          field: 'movement_type',
          severity: 'ERROR',
          code: 'UNKNOWN_MOVEMENT_TYPE',
          message: `The organization has no base type "${row.code.typeName}"`,
        });
      } else if (
        warehouse &&
        !lookups.allowedTypes.get(warehouse.id)?.has(type.id)
      ) {
        add(row, {
          field: 'movement_type',
          severity: 'ERROR',
          code: 'MOVEMENT_TYPE_NOT_ALLOWED',
          message: `Your roles do not allow "${row.code.typeName}" in this warehouse`,
        });
      } else {
        row.movementTypeId = type.id;
        row.countsAsDemand = type.countsAsDemand;
      }
    }

    if (
      product &&
      row.stockUnit &&
      lower(row.stockUnit) !== lower(product.unitCode)
    ) {
      add(row, {
        field: 'stock_unit',
        severity: 'ERROR',
        code: 'UNIT_MISMATCH',
        message: `The product is counted in ${product.unitCode}`,
      });
    }

    if (warehouse) {
      const code = row.locationCode ?? DEFAULT_LOCATION;
      const location = lookups.locations.get(`${warehouse.id}:${lower(code)}`);
      if (location === undefined) {
        add(row, {
          field: 'location_code',
          severity: 'ERROR',
          code: 'UNKNOWN_LOCATION',
          message: 'No location with this code in the warehouse',
        });
      }
      row.locationId = location;
    }

    if (product) {
      if (product.tracksLots && !row.lotCode && row.source.lot_code === '') {
        add(row, {
          field: 'lot_code',
          severity: 'ERROR',
          code: 'LOT_REQUIRED',
          message: 'The product is tracked by lot',
        });
      } else if (!product.tracksLots && row.lotCode) {
        add(row, {
          field: 'lot_code',
          severity: 'ERROR',
          code: 'LOT_NOT_ALLOWED',
          message: 'The product is not tracked by lot',
        });
      } else if (row.lotCode) {
        row.lotId = lookups.lots.get(`${product.id}:${lower(row.lotCode)}`);
        if (row.lotId === undefined) {
          add(row, {
            field: 'lot_code',
            severity: 'WARNING',
            code: 'LOT_NOT_FOUND',
            message: 'The lot does not exist in Pango yet',
          });
        }
      }
    }
  }

  // Repeated source keys within the file.
  const byKey = new Map<string, ValidatedRow[]>();
  for (const row of rows) {
    const key = sourceKey(row);
    if (!key) continue;
    const copies = byKey.get(key);
    if (copies) copies.push(row);
    else byKey.set(key, [row]);
  }
  for (const copies of byKey.values()) {
    if (copies.length < 2) continue;
    const prints = new Set(copies.map(fingerprint));
    if (prints.size === 1) {
      for (const copy of copies.slice(1)) {
        copy.status = 'DUPLICATE';
        add(copy, {
          field: null,
          severity: 'WARNING',
          code: 'DUPLICATE_ROW',
          message: `Repeats row ${copies[0].rowNumber}; it is counted once`,
        });
      }
    } else {
      const others = copies.map((c) => c.rowNumber).join(', ');
      for (const copy of copies) {
        add(copy, {
          field: 'external_movement_id',
          severity: 'ERROR',
          code: 'KEY_CONFLICT',
          message: `Rows ${others} share this movement id and line but differ`,
        });
      }
    }
  }

  // Lines already in the history from an earlier import of the same source.
  for (const row of rows) {
    if (row.status === 'DUPLICATE') continue;
    const key = sourceKey(row);
    const saved = key ? options.existing.get(key) : undefined;
    if (!saved) continue;
    const resolved =
      row.businessDate && row.warehouseId && row.productId && row.movementCode
        ? historyFingerprint({
            businessDate: row.businessDate,
            warehouseId: row.warehouseId,
            productId: row.productId,
            movementCode: row.movementCode,
            quantityIn: row.quantityIn ?? null,
            quantityOut: row.quantityOut ?? null,
            locationCode: row.locationCode ?? null,
            lotCode: row.lotCode ?? null,
            unitCost: row.unitCost ?? null,
          })
        : null;
    if (resolved === saved) {
      row.alreadyImported = true;
      add(row, {
        field: null,
        severity: 'WARNING',
        code: 'ALREADY_IMPORTED',
        message: 'This line is already in the history; it is not saved again',
      });
    } else {
      add(row, {
        field: 'external_movement_id',
        severity: 'ERROR',
        code: 'IMPORTED_DIFFERENTLY',
        message:
          'This movement id and line were already imported with other values',
      });
    }
  }

  // Document consistency: the lines of one source movement (per transfer leg).
  const byDocument = new Map<string, ValidatedRow[]>();
  for (const row of rows) {
    if (row.status === 'DUPLICATE' || !row.externalMovementId || !row.leg)
      continue;
    const list = byDocument.get(row.externalMovementId) ?? [];
    list.push(row);
    byDocument.set(row.externalMovementId, list);
  }
  for (const lines of byDocument.values()) {
    const legs = new Set(lines.map((l) => l.leg));
    let field: string | null = null;
    if (legs.has('LINE') && legs.size > 1) field = 'movement_type';
    else {
      for (const leg of legs) {
        const group = lines.filter((l) => l.leg === leg);
        const differs = (value: (l: ValidatedRow) => string | undefined) =>
          new Set(group.map(value)).size > 1;
        if (differs((l) => l.businessDate)) field = 'business_date';
        else if (differs((l) => l.warehouseCode && lower(l.warehouseCode)))
          field = 'warehouse_code';
        else if (differs((l) => l.movementCode)) field = 'movement_type';
        else if (differs((l) => l.documentRef ?? '')) field = 'document_ref';
        if (field) break;
      }
    }
    if (!field) continue;
    const rowsList = lines.map((l) => l.rowNumber).join(', ');
    for (const line of lines) {
      add(line, {
        field: field as keyof ParsedRow['source'],
        severity: 'ERROR',
        code: 'DOCUMENT_INCONSISTENT',
        message: `The lines of movement ${line.externalMovementId} (rows ${rowsList}) must share date, warehouse, movement type and document reference`,
      });
    }
  }

  // Balances the file reports, per product and warehouse in event order. A row
  // with errors breaks the chain until a later reported balance restarts it.
  const byPair = new Map<string, ValidatedRow[]>();
  for (const row of rows) {
    if (row.status === 'DUPLICATE' || !row.warehouseId || !row.productId)
      continue;
    if (!row.businessDate) continue;
    const key = `${row.warehouseId}:${row.productId}`;
    const list = byPair.get(key);
    if (list) list.push(row);
    else byPair.set(key, [row]);
  }
  for (const pairRows of byPair.values()) {
    pairRows.sort(
      (a, b) =>
        a.businessDate!.localeCompare(b.businessDate!) ||
        a.rowNumber - b.rowNumber,
    );
    let running: Decimal | undefined;
    for (const row of pairRows) {
      const delta = row.quantityIn ?? row.quantityOut?.neg();
      if (errors.has(row.rowNumber) || !delta) {
        running = undefined;
        continue;
      }
      if (running === undefined && row.movementCode === 'OPENING_BALANCE') {
        running = new Prisma.Decimal(0);
      }
      if (running !== undefined) {
        running = running.add(delta);
        if (row.balanceAfter && !row.balanceAfter.eq(running)) {
          add(row, {
            field: 'balance_after',
            severity: 'ERROR',
            code: 'BALANCE_MISMATCH',
            message: `The movements give ${running.toString()} after this row`,
          });
          running = row.balanceAfter;
        }
      } else if (row.balanceAfter) {
        running = row.balanceAfter;
      }
      row.runningBalance = running;
    }
    const valid = pairRows.filter((r) => !errors.has(r.rowNumber));
    if (
      valid.length > 0 &&
      valid.every((r) => r.runningBalance === undefined)
    ) {
      add(valid[0], {
        field: null,
        severity: 'WARNING',
        code: 'NO_BALANCE',
        message:
          'No opening balance or balance_after for this product in this warehouse: ' +
          'the forecast gets its demand but not its stock, so it cannot tell stockouts',
      });
    }
  }

  for (const row of rows) {
    if (row.status === 'DUPLICATE') continue;
    row.status = errors.has(row.rowNumber)
      ? 'INVALID'
      : row.alreadyImported
        ? 'DUPLICATE'
        : 'VALID';
    if (row.status === 'INVALID') row.runningBalance = undefined;
    if (row.status !== 'INVALID' && row.countsAsDemand && row.quantityOut) {
      row.demandQuantity = row.quantityOut;
    }
  }
  // By row (file-level first); within a row, in the order found.
  issues.sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0));
  return { rows, issues };
}
