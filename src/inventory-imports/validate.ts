// The rules of an inventory import (docs/modules/inventary.md, INV-FR and INV-BR),
// applied to typed rows and the organization's data. Pure: no database access, so
// the preview and the confirmation (which re-validates under locks) share it.
import type { Prisma } from '../generated/prisma/tenant/client.js';
import type { InventoryField } from './fields.js';
import { type ImportScope, mayImportInto } from './inventory-import-access.js';
import { fold, type ParsedRow, type RowIssue, type Severity } from './parse.js';

/**
 * How Pango compares SKUs, warehouse codes and names, category names and
 * location codes: ignoring case, not accents (as `lower()` in PostgreSQL).
 */
export const lower = (value: string) => value.toLowerCase();

type Decimal = Prisma.Decimal;

// ─── What validation needs from the database ────────────────────────────────

export interface ProductInfo {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  categoryId: number;
  categoryName: string;
  unitCode: string;
  tracksLots: boolean;
  isActive: boolean;
  lengthCm: Decimal | null;
  widthCm: Decimal | null;
  heightCm: Decimal | null;
  weightKg: Decimal | null;
  volumeL: Decimal | null;
}

export interface CategoryInfo {
  id: number;
  name: string;
  isActive: boolean;
}

export interface WarehouseInfo {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  holdsStock: boolean;
  defaultLocationId: number | null;
}

export interface LocationInfo {
  id: number;
  code: string;
  isActive: boolean;
}

export interface LotInfo {
  id: number;
  code: string;
  manufactureDate: string | null;
  expiryDate: string | null;
}

export interface Lookups {
  /** Unit code by every accepted spelling, folded (code and aliases). */
  units: Map<string, string>;
  /** By lower-case SKU. */
  products: Map<string, ProductInfo>;
  /** Every category with that lower-case name. */
  categories: Map<string, CategoryInfo[]>;
  /** By lower-case code, and by lower-case name. */
  warehousesByCode: Map<string, WarehouseInfo>;
  warehousesByName: Map<string, WarehouseInfo>;
  /** By `${warehouseId}:${lower-case code}`. */
  locations: Map<string, LocationInfo>;
  /** Default location of a product in a warehouse, by `${productId}:${warehouseId}`. */
  productDefaults: Map<string, number | null>;
  /** By `${productId}:${code}` (lot codes are exact, as movements match them). */
  lots: Map<string, LotInfo>;
  /** Identities that ever had stock or movements: `${productId}:${locationId}:${lotId ?? ''}`. */
  usedIdentities: Set<string>;
  /** Warehouses the user may import into (INV-BR-15). */
  scope: ImportScope;
}

// ─── What validation produces ───────────────────────────────────────────────

/** An existing entity (`id`) or one the confirmation would create (`key`). */
export type Ref = { id: number } | { key: string };

export interface NewCategory {
  key: string;
  name: string;
}

export interface NewWarehouse {
  key: string;
  code: string;
  name: string;
  type: 'WAREHOUSE' | 'STORE';
  address: string | null;
}

export interface NewProduct {
  key: string;
  sku: string;
  name: string;
  category: Ref;
  unitCode: string;
  tracksLots: boolean;
  description: string | null;
  lengthCm: string | null;
  widthCm: string | null;
  heightCm: string | null;
  weightKg: string | null;
  volumeL: string | null;
}

export interface NewLot {
  key: string;
  product: Ref;
  code: string;
  manufactureDate: string | null;
  expiryDate: string | null;
}

/** Stock one row puts in Pango. Quantities and costs keep their exact digits. */
export interface StockLine {
  rowNumber: number;
  product: Ref;
  warehouse: Ref;
  /** An existing location, or the default location of a new warehouse. */
  location: Ref;
  lot: Ref | null;
  quantity: string;
  unitCost: string | null;
}

export interface ImportPlan {
  categories: NewCategory[];
  warehouses: NewWarehouse[];
  products: NewProduct[];
  lots: NewLot[];
  lines: StockLine[];
}

export type RowStatus = 'VALID' | 'INVALID' | 'DUPLICATE';

export interface RowPreview {
  rowNumber: number;
  status: RowStatus;
  sku: string | null;
  product: { id: number | null; name: string | null; isNew: boolean } | null;
  category: { id: number | null; name: string | null; isNew: boolean } | null;
  warehouse: {
    id: number | null;
    code: string | null;
    name: string | null;
    isNew: boolean;
  } | null;
  locationCode: string | null;
  lot: { id: number | null; code: string; isNew: boolean } | null;
  stockUnit: string | null;
  quantity: string | null;
  unitCost: string | null;
  issues: number;
}

export interface ValidationSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  errors: number;
  warnings: number;
  issueCounts: Record<string, number>;
  stockRows: number;
  create: {
    categories: number;
    products: number;
    warehouses: number;
    lots: number;
  };
  reuse: {
    categories: number;
    products: number;
    warehouses: number;
    lots: number;
  };
  /** Existing warehouses the rows name (internal: drives who may see the import). */
  warehouseIds: number[];
}

export interface ValidationResult {
  rows: RowPreview[];
  issues: RowIssue[];
  summary: ValidationSummary;
  plan: ImportPlan;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

const REQUIRED: InventoryField[] = [
  'sku',
  'name',
  'category',
  'stockUnit',
  'warehouse',
  'tracksLots',
  'stockQuantity',
];

const LABELS: Record<string, string> = {
  sku: 'Código producto',
  name: 'Producto',
  category: 'Categoría',
  stockUnit: 'Unidad de medida',
  warehouse: 'Bodega',
  tracksLots: 'Seguimiento',
  stockQuantity: 'Saldo inicial',
};

const DEFAULT_LOCATION = 'default';

const refKey = (ref: Ref) => ('id' in ref ? `#${ref.id}` : ref.key);
const sameDecimal = (a: Decimal | null | undefined, b: Decimal | null) =>
  (a ?? null) === null ? b === null : b !== null && a!.eq(b);
const text = (value: Decimal | undefined) => value?.toString() ?? null;

/** Per-row working state while the rules run. */
interface Work {
  row: ParsedRow;
  issues: RowIssue[];
  unitCode?: string;
  product?: { ref: Ref; info?: ProductInfo; key?: string };
  warehouse?: { ref: Ref; info?: WarehouseInfo; key?: string };
  location?: { ref: Ref; code: string };
  lot?: { ref: Ref; code: string; info?: LotInfo };
  identity?: string;
}

/**
 * Applies every rule to the rows of an import. `parseIssues` are the cell issues
 * found while typing the rows.
 */
export function validateRows(
  parsed: { row: ParsedRow; issues: RowIssue[] }[],
  lookups: Lookups,
): ValidationResult {
  const works: Work[] = [...parsed]
    .sort((a, b) => a.row.rowNumber - b.row.rowNumber)
    .map(({ row, issues }) => ({ row, issues: [...issues] }));
  const importIssues: RowIssue[] = [];

  const issue = (
    work: Work,
    field: InventoryField | null,
    severity: Severity,
    code: string,
    message: string,
    value: string | null = null,
  ) =>
    work.issues.push({
      rowNumber: work.row.rowNumber,
      field,
      severity,
      code,
      message,
      value: value?.slice(0, 200) ?? null,
    });
  const error = (
    work: Work,
    field: InventoryField | null,
    code: string,
    message: string,
    value: string | null = null,
  ) => issue(work, field, 'ERROR', code, message, value);

  // New entities, defined by the first row that names them (INV-BR-18).
  const newCategories = new Map<string, NewCategory>();
  const newWarehouses = new Map<string, NewWarehouse & { firstRow: number }>();
  const newProducts = new Map<
    string,
    NewProduct & { firstRow: number; warned: boolean }
  >();
  const newLots = new Map<
    string,
    NewLot & { firstRow: number; warned: boolean }
  >();
  const warnedProducts = new Set<number>();
  const warnedLots = new Set<number>();

  for (const work of works) {
    const { row } = work;

    // Required values (a value that failed typing already has its issue).
    for (const field of REQUIRED) {
      const present = row[field as keyof ParsedRow] !== undefined;
      const failed = work.issues.some((i) => i.field === field);
      if (!present && !failed) {
        error(work, field, 'REQUIRED_FIELD', `${LABELS[field]} is required`);
      }
    }

    // Unit of measure (INV-BR-11).
    if (row.stockUnit !== undefined) {
      const code = lookups.units.get(fold(row.stockUnit));
      if (code) work.unitCode = code;
      else {
        error(
          work,
          'stockUnit',
          'STOCK_UNIT_INVALID',
          'The unit of measure is not registered in Pango',
          row.stockUnit,
        );
      }
    }

    // Lot required or refused by the tracking (INV-BR-08).
    if (row.tracksLots === true && row.lotCode === undefined) {
      error(
        work,
        'lotCode',
        'LOT_REQUIRED',
        'Lot-tracked products need a lot code',
      );
    }
    if (row.tracksLots === false && row.lotCode !== undefined) {
      error(
        work,
        'lotCode',
        'LOT_NOT_ALLOWED',
        'Products tracked by quantity take no lot code',
        row.lotCode,
      );
    }
    if (
      row.manufactureDate !== undefined &&
      row.expiryDate !== undefined &&
      row.expiryDate < row.manufactureDate
    ) {
      error(
        work,
        'expiryDate',
        'LOT_DATES_INVALID',
        'The expiry date is before the manufacture date',
        row.expiryDate,
      );
    }

    resolveProduct(work);
    resolveWarehouse(work);
    resolveLocation(work);
    resolveLot(work);

    // Opening only (INV-FR-05): the identity never had stock or movements.
    const product = work.product?.ref;
    const location = work.location?.ref;
    if (product && 'id' in product && location && 'id' in location) {
      const lot = work.lot?.ref;
      if (!lot || 'id' in lot) {
        const used = `${product.id}:${location.id}:${lot && 'id' in lot ? lot.id : ''}`;
        if (lookups.usedIdentities.has(used)) {
          error(
            work,
            null,
            'ALREADY_HAS_STOCK',
            'This product already had stock or movements in this warehouse, location and lot; an opening cannot load it again',
          );
        }
      }
    }

    // Missing cost (INV-BR-01): only where stock comes in.
    if (row.stockQuantity?.gt(0) && row.unitCost === undefined) {
      issue(
        work,
        'unitCost',
        'WARNING',
        'COST_MISSING',
        "No unit cost: the stock takes the product's current average cost",
      );
    }

    if (work.product && work.warehouse && work.location) {
      work.identity = [
        refKey(work.product.ref),
        refKey(work.warehouse.ref),
        refKey(work.location.ref),
        row.lotCode ?? '',
      ].join('|');
    }
  }

  // ─── Same identity twice (INV-BR-12) ──────────────────────────────────────
  const byIdentity = new Map<string, Work[]>();
  for (const work of works) {
    if (!work.identity) continue;
    byIdentity.set(work.identity, [
      ...(byIdentity.get(work.identity) ?? []),
      work,
    ]);
  }
  const duplicates = new Set<Work>();
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const signature = (w: Work) => rowSignature(w.row);
    if (group.every((w) => signature(w) === signature(group[0]))) {
      for (const work of group.slice(1)) {
        duplicates.add(work);
        issue(
          work,
          null,
          'WARNING',
          'DUPLICATE_ROW',
          `Identical to row ${group[0].row.rowNumber}: counted once`,
        );
      }
    } else {
      const rows = group.map((w) => w.row.rowNumber).join(', ');
      for (const work of group) {
        error(
          work,
          null,
          'ROW_CONFLICT',
          `Rows ${rows} name the same product, warehouse, location and lot with different values`,
        );
      }
    }
  }

  // ─── Results ──────────────────────────────────────────────────────────────
  const status = (work: Work): RowStatus =>
    work.issues.some((i) => i.severity === 'ERROR')
      ? 'INVALID'
      : duplicates.has(work)
        ? 'DUPLICATE'
        : 'VALID';

  const plan: ImportPlan = {
    categories: [],
    warehouses: [],
    products: [],
    lots: [],
    lines: [],
  };
  const used = {
    categories: new Set<string>(),
    products: new Set<string>(),
    warehouses: new Set<string>(),
    lots: new Set<string>(),
  };
  const reuse = {
    categories: new Set<number>(),
    products: new Set<number>(),
    warehouses: new Set<number>(),
    lots: new Set<number>(),
  };
  const warehouseIds = new Set<number>();

  const rows: RowPreview[] = works.map((work) => {
    const rowStatus = status(work);
    const { row } = work;
    const productInfo = work.product?.info;
    const newProduct = work.product?.key
      ? newProducts.get(work.product.key)
      : undefined;
    const categoryRef = productInfo
      ? ({ id: productInfo.categoryId } as Ref)
      : newProduct?.category;
    const category =
      categoryRef === undefined
        ? null
        : 'id' in categoryRef
          ? {
              id: categoryRef.id,
              name:
                productInfo?.categoryName ??
                categoryName(lookups, categoryRef.id),
              isNew: false,
            }
          : {
              id: null,
              name: newCategories.get(categoryRef.key)?.name ?? null,
              isNew: true,
            };
    const warehouseInfo = work.warehouse?.info;
    if (warehouseInfo) warehouseIds.add(warehouseInfo.id);
    const newWarehouse = work.warehouse?.key
      ? newWarehouses.get(work.warehouse.key)
      : undefined;

    if (rowStatus !== 'INVALID') {
      // What this row needs to exist, and the stock it brings.
      if (work.product?.key) used.products.add(work.product.key);
      if (productInfo) reuse.products.add(productInfo.id);
      if (categoryRef) {
        if ('id' in categoryRef) reuse.categories.add(categoryRef.id);
        else used.categories.add(categoryRef.key);
      }
      if (work.warehouse?.key) used.warehouses.add(work.warehouse.key);
      if (warehouseInfo) reuse.warehouses.add(warehouseInfo.id);
      const quantity = row.stockQuantity;
      if (rowStatus === 'VALID' && quantity?.gt(0)) {
        if (work.lot) {
          if ('id' in work.lot.ref) reuse.lots.add(work.lot.ref.id);
          else used.lots.add(work.lot.ref.key);
        }
        plan.lines.push({
          rowNumber: row.rowNumber,
          product: work.product!.ref,
          warehouse: work.warehouse!.ref,
          location: work.location!.ref,
          lot: work.lot?.ref ?? null,
          quantity: quantity.toString(),
          unitCost: text(row.unitCost),
        });
      }
    }

    return {
      rowNumber: row.rowNumber,
      status: rowStatus,
      sku: row.sku ?? null,
      product: work.product
        ? {
            id: productInfo?.id ?? null,
            name: productInfo?.name ?? newProduct?.name ?? row.name ?? null,
            isNew: !productInfo,
          }
        : null,
      category,
      warehouse: work.warehouse
        ? {
            id: warehouseInfo?.id ?? null,
            code: warehouseInfo?.code ?? newWarehouse?.code ?? null,
            name: warehouseInfo?.name ?? newWarehouse?.name ?? null,
            isNew: !warehouseInfo,
          }
        : null,
      locationCode: work.location?.code ?? row.locationCode ?? null,
      lot: work.lot
        ? {
            id: 'id' in work.lot.ref ? work.lot.ref.id : null,
            code: work.lot.code,
            isNew: !('id' in work.lot.ref),
          }
        : null,
      stockUnit: work.unitCode ?? row.stockUnit ?? null,
      quantity: text(row.stockQuantity),
      unitCost: text(row.unitCost),
      issues: work.issues.length,
    };
  });

  for (const [key, category] of newCategories) {
    if (used.categories.has(key)) plan.categories.push(category);
  }
  for (const [key, warehouse] of newWarehouses) {
    if (used.warehouses.has(key)) {
      const { firstRow: _firstRow, ...rest } = warehouse;
      plan.warehouses.push(rest);
    }
  }
  for (const [key, product] of newProducts) {
    if (used.products.has(key)) {
      const { firstRow: _firstRow, warned: _warned, ...rest } = product;
      plan.products.push(rest);
    }
  }
  for (const [key, lot] of newLots) {
    if (used.lots.has(key)) {
      const { firstRow: _firstRow, warned: _warned, ...rest } = lot;
      plan.lots.push(rest);
    }
  }

  const issues = [...importIssues, ...works.flatMap((w) => w.issues)];
  const issueCounts: Record<string, number> = {};
  for (const i of issues) issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;

  return {
    rows,
    issues,
    plan,
    summary: {
      totalRows: rows.length,
      validRows: count('VALID'),
      invalidRows: count('INVALID'),
      duplicateRows: count('DUPLICATE'),
      errors: issues.filter((i) => i.severity === 'ERROR').length,
      warnings: issues.filter((i) => i.severity === 'WARNING').length,
      issueCounts,
      stockRows: plan.lines.length,
      create: {
        categories: plan.categories.length,
        products: plan.products.length,
        warehouses: plan.warehouses.length,
        lots: plan.lots.length,
      },
      reuse: {
        categories: reuse.categories.size,
        products: reuse.products.size,
        warehouses: reuse.warehouses.size,
        lots: reuse.lots.size,
      },
      warehouseIds: [...warehouseIds].sort((a, b) => a - b),
    },
  };

  // ─── Resolution of each entity ────────────────────────────────────────────

  function resolveProduct(work: Work) {
    const { row } = work;
    if (row.sku === undefined) return;
    const skuKey = lower(row.sku);
    const existing = lookups.products.get(skuKey);
    if (existing) {
      work.product = { ref: { id: existing.id }, info: existing };
      if (!existing.isActive) {
        error(
          work,
          'sku',
          'PRODUCT_INACTIVE',
          'The product is inactive in Pango',
          row.sku,
        );
      }
      if (work.unitCode && work.unitCode !== existing.unitCode) {
        error(
          work,
          'stockUnit',
          'UNIT_MISMATCH',
          `The product is counted in ${existing.unitCode} in Pango`,
          row.stockUnit ?? null,
        );
      }
      if (
        row.tracksLots !== undefined &&
        row.tracksLots !== existing.tracksLots
      ) {
        error(
          work,
          'tracksLots',
          'TRACKING_MISMATCH',
          existing.tracksLots
            ? 'The product is tracked by lot in Pango'
            : 'The product is tracked by quantity in Pango',
        );
      }
      // Descriptive differences keep Pango's values (INV-BR-02), once per product.
      if (!warnedProducts.has(existing.id)) {
        const differs = productDifferences(row, existing);
        if (differs.length > 0) {
          warnedProducts.add(existing.id);
          issue(
            work,
            null,
            'WARNING',
            'PRODUCT_DIFFERS',
            `${differs.join(', ')} differ from Pango's; Pango's are kept`,
          );
        }
      }
      return;
    }

    const key = `product:${skuKey}`;
    work.product = { ref: { key }, key };
    const defined = newProducts.get(key);
    if (!defined) {
      if (
        !work.unitCode ||
        row.tracksLots === undefined ||
        row.name === undefined
      ) {
        // Cannot define the product; its own issues say why.
        return;
      }
      newProducts.set(key, {
        key,
        sku: row.sku,
        name: row.name,
        category: resolveCategory(work) ?? { key: 'category:?' },
        unitCode: work.unitCode,
        tracksLots: row.tracksLots,
        description: row.description ?? null,
        lengthCm: text(row.lengthCm),
        widthCm: text(row.widthCm),
        heightCm: text(row.heightCm),
        weightKg: text(row.weightKg),
        volumeL: text(row.volumeL),
        firstRow: row.rowNumber,
        warned: false,
      });
      return;
    }
    // Later rows of a new SKU only add stock (INV-BR-18).
    if (
      (work.unitCode && work.unitCode !== defined.unitCode) ||
      (row.tracksLots !== undefined && row.tracksLots !== defined.tracksLots)
    ) {
      error(
        work,
        work.unitCode && work.unitCode !== defined.unitCode
          ? 'stockUnit'
          : 'tracksLots',
        'PRODUCT_INCONSISTENT',
        `Row ${defined.firstRow} gives this product another unit or tracking`,
      );
      return;
    }
    if (!defined.warned) {
      const differs: string[] = [];
      if (row.name !== undefined && row.name !== defined.name)
        differs.push('name');
      if (
        row.category !== undefined &&
        lower(row.category) !== categoryFold(defined.category)
      ) {
        differs.push('category');
      }
      if (
        (row.description ?? null) !== defined.description &&
        row.description !== undefined
      ) {
        differs.push('description');
      }
      for (const field of [
        'lengthCm',
        'widthCm',
        'heightCm',
        'weightKg',
        'volumeL',
      ] as const) {
        if (row[field] !== undefined && text(row[field]) !== defined[field]) {
          differs.push(field);
        }
      }
      if (differs.length > 0) {
        defined.warned = true;
        issue(
          work,
          null,
          'WARNING',
          'PRODUCT_VALUES_DIFFER',
          `${differs.join(', ')} differ from row ${defined.firstRow}; row ${defined.firstRow}'s are used`,
        );
      }
    }
  }

  function categoryFold(ref: Ref): string {
    if ('id' in ref) return lower(categoryName(lookups, ref.id) ?? '');
    return lower(newCategories.get(ref.key)?.name ?? '');
  }

  /** INV-BR-05: one match reused, several ambiguous, none created at the top level. */
  function resolveCategory(work: Work): Ref | undefined {
    const name = work.row.category;
    if (name === undefined) return undefined;
    const nameKey = lower(name);
    const matches = lookups.categories.get(nameKey) ?? [];
    if (matches.length > 1) {
      error(
        work,
        'category',
        'CATEGORY_AMBIGUOUS',
        'Several categories have this name in Pango',
        name,
      );
      return undefined;
    }
    if (matches.length === 1) {
      if (!matches[0].isActive) {
        error(
          work,
          'category',
          'CATEGORY_INACTIVE',
          'The category is inactive in Pango',
          name,
        );
        return undefined;
      }
      return { id: matches[0].id };
    }
    const key = `category:${nameKey}`;
    if (!newCategories.has(key)) newCategories.set(key, { key, name });
    return { key };
  }

  /** INV-BR-06 and INV-BR-15. */
  function resolveWarehouse(work: Work) {
    const { row } = work;
    if (row.warehouse === undefined) return;
    const byName = lookups.warehousesByName.get(lower(row.warehouse));
    const byCode =
      row.warehouseCode === undefined
        ? undefined
        : lookups.warehousesByCode.get(lower(row.warehouseCode));
    let existing: WarehouseInfo | undefined;
    if (row.warehouseCode !== undefined) {
      if (byCode && byName && byCode.id !== byName.id) {
        // Never confirm warehouses the user may not import into.
        if (
          !mayImportInto(lookups.scope, byCode.id) ||
          !mayImportInto(lookups.scope, byName.id)
        ) {
          forbidden(work);
          return;
        }
        error(
          work,
          'warehouseCode',
          'WAREHOUSE_CONFLICT',
          'The warehouse code and name point to different warehouses',
          row.warehouseCode,
        );
        return;
      }
      if ((byCode && !byName) || (!byCode && byName)) {
        const found = (byCode ?? byName)!;
        if (!mayImportInto(lookups.scope, found.id)) {
          forbidden(work);
          return;
        }
        error(
          work,
          byCode ? 'warehouse' : 'warehouseCode',
          'WAREHOUSE_CONFLICT',
          byCode
            ? `The warehouse with this code is called ${found.name}`
            : `The warehouse with this name has the code ${found.code}`,
          byCode ? row.warehouse : row.warehouseCode,
        );
        return;
      }
      existing = byCode;
    } else {
      existing = byName;
    }

    if (existing) {
      if (!mayImportInto(lookups.scope, existing.id)) {
        forbidden(work);
        return;
      }
      work.warehouse = { ref: { id: existing.id }, info: existing };
      if (!existing.isActive) {
        error(
          work,
          'warehouse',
          'WAREHOUSE_INACTIVE',
          'The warehouse is inactive in Pango',
          row.warehouse,
        );
      }
      if (!existing.holdsStock && row.stockQuantity?.gt(0)) {
        error(
          work,
          'stockQuantity',
          'NON_STOCK_WAREHOUSE',
          'This warehouse does not hold stock',
          row.stockQuantity.toString(),
        );
      }
      return;
    }

    // A new warehouse, keyed by its code; later rows may name it by name only.
    const named = [...newWarehouses.values()].find(
      (w) => lower(w.name) === lower(row.warehouse!),
    );
    if (row.warehouseCode === undefined) {
      if (named) {
        work.warehouse = { ref: { key: named.key }, key: named.key };
        return;
      }
      error(
        work,
        'warehouseCode',
        'WAREHOUSE_CODE_REQUIRED',
        'A new warehouse needs its code',
      );
      return;
    }
    const key = `warehouse:${lower(row.warehouseCode)}`;
    if (named && named.key !== key) {
      error(
        work,
        'warehouseCode',
        'WAREHOUSE_CONFLICT',
        `Row ${named.firstRow} gives this warehouse name another code`,
        row.warehouseCode,
      );
      return;
    }
    const defined = newWarehouses.get(key);
    if (defined && lower(defined.name) !== lower(row.warehouse)) {
      error(
        work,
        'warehouse',
        'WAREHOUSE_CONFLICT',
        `Row ${defined.firstRow} gives this warehouse code another name`,
        row.warehouse,
      );
      return;
    }
    if (!defined) {
      newWarehouses.set(key, {
        key,
        code: row.warehouseCode,
        name: row.warehouse,
        type: row.warehouseType ?? 'WAREHOUSE',
        address: row.warehouseAddress ?? null,
        firstRow: row.rowNumber,
      });
    }
    work.warehouse = { ref: { key }, key };
  }

  function forbidden(work: Work) {
    error(
      work,
      'warehouse',
      'WAREHOUSE_FORBIDDEN',
      'You may not import into this warehouse',
      work.row.warehouse ?? null,
    );
  }

  /** INV-BR-07: blank → product default or DEFAULT; given → must exist and be active. */
  function resolveLocation(work: Work) {
    const warehouse = work.warehouse;
    if (!warehouse) return;
    const given = work.row.locationCode;
    if (warehouse.key) {
      // A new warehouse has only its DEFAULT location.
      if (given !== undefined && lower(given) !== DEFAULT_LOCATION) {
        error(
          work,
          'locationCode',
          'LOCATION_INVALID',
          'A new warehouse only has its DEFAULT location',
          given,
        );
        return;
      }
      work.location = {
        ref: { key: `location:${warehouse.key}` },
        code: 'DEFAULT',
      };
      return;
    }
    const info = warehouse.info!;
    if (given === undefined) {
      const product = work.product?.info;
      const productDefault = product
        ? lookups.productDefaults.get(`${product.id}:${info.id}`)
        : undefined;
      const id = productDefault ?? info.defaultLocationId;
      if (id === null || id === undefined) {
        error(
          work,
          'locationCode',
          'LOCATION_INVALID',
          'The warehouse has no default location',
        );
        return;
      }
      const code =
        [...lookups.locations.values()].find((l) => l.id === id)?.code ??
        'DEFAULT';
      work.location = { ref: { id }, code };
      return;
    }
    const location = lookups.locations.get(`${info.id}:${lower(given)}`);
    if (!location?.isActive) {
      error(
        work,
        'locationCode',
        'LOCATION_INVALID',
        'Not an active location of this warehouse',
        given,
      );
      return;
    }
    work.location = { ref: { id: location.id }, code: location.code };
  }

  /** INV-BR-08: existing lots reused (Pango's dates kept); new ones take the file's. */
  function resolveLot(work: Work) {
    const { row } = work;
    if (row.lotCode === undefined || row.tracksLots !== true || !work.product)
      return;
    const product = work.product;
    const existing =
      'id' in product.ref
        ? lookups.lots.get(`${product.ref.id}:${row.lotCode}`)
        : undefined;
    const fileDates = {
      manufactureDate: row.manufactureDate ?? null,
      expiryDate: row.expiryDate ?? null,
    };
    if (existing) {
      work.lot = {
        ref: { id: existing.id },
        code: existing.code,
        info: existing,
      };
      const differs =
        (fileDates.manufactureDate !== null &&
          fileDates.manufactureDate !== existing.manufactureDate) ||
        (fileDates.expiryDate !== null &&
          fileDates.expiryDate !== existing.expiryDate);
      if (differs && !warnedLots.has(existing.id)) {
        warnedLots.add(existing.id);
        issue(
          work,
          null,
          'WARNING',
          'LOT_DATES_DIFFER',
          "The lot's dates differ from Pango's; Pango's are kept",
        );
      }
      return;
    }
    const key = `lot:${refKey(product.ref)}:${row.lotCode}`;
    const defined = newLots.get(key);
    if (!defined) {
      newLots.set(key, {
        key,
        product: product.ref,
        code: row.lotCode,
        ...fileDates,
        firstRow: row.rowNumber,
        warned: false,
      });
    } else if (
      !defined.warned &&
      ((fileDates.manufactureDate !== null &&
        fileDates.manufactureDate !== defined.manufactureDate) ||
        (fileDates.expiryDate !== null &&
          fileDates.expiryDate !== defined.expiryDate))
    ) {
      defined.warned = true;
      issue(
        work,
        null,
        'WARNING',
        'LOT_DATES_DIFFER',
        `The lot's dates differ from row ${defined.firstRow}; row ${defined.firstRow}'s are used`,
      );
    }
    work.lot = { ref: { key }, code: row.lotCode };
  }
}

function categoryName(lookups: Lookups, id: number): string | null {
  for (const list of lookups.categories.values()) {
    const found = list.find((c) => c.id === id);
    if (found) return found.name;
  }
  return null;
}

/** Descriptive fields of a row that differ from an existing product. */
function productDifferences(row: ParsedRow, product: ProductInfo): string[] {
  const differs: string[] = [];
  if (row.name !== undefined && row.name !== product.name) differs.push('name');
  if (
    row.category !== undefined &&
    lower(row.category) !== lower(product.categoryName)
  ) {
    differs.push('category');
  }
  if (
    row.description !== undefined &&
    row.description !== (product.description ?? '')
  ) {
    differs.push('description');
  }
  for (const field of [
    'lengthCm',
    'widthCm',
    'heightCm',
    'weightKg',
    'volumeL',
  ] as const) {
    if (row[field] !== undefined && !sameDecimal(row[field], product[field])) {
      differs.push(field);
    }
  }
  return differs;
}

/** Every typed value of a row, to tell identical rows from conflicting ones. */
function rowSignature(row: ParsedRow): string {
  const { rowNumber: _rowNumber, ...values } = row;
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => {
        const value = (values as Record<string, unknown>)[key];
        return [key, value === undefined ? null : String(value)];
      }),
  );
}
