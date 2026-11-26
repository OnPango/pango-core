// Reads what validation needs from the organization, with a handful of set-based
// queries (never one per row). Runs inside the caller's transaction, so the
// confirmation can read under its locks.
import type { AuthContext } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { UNIT_ALIASES } from './fields.js';
import { importScope } from './inventory-import-access.js';
import { fold, type ParsedRow } from './parse.js';
import {
  type CategoryInfo,
  type LocationInfo,
  type Lookups,
  lower,
  type ProductInfo,
  type WarehouseInfo,
} from './validate.js';

type Tx = Prisma.TransactionClient;

const unique = (values: (string | undefined)[]) => [
  ...new Set(values.filter((v): v is string => v !== undefined)),
];

const day = (date: Date | null) =>
  date === null ? null : date.toISOString().slice(0, 10);

const decimal = (value: string | null) =>
  value === null ? null : new Prisma.Decimal(value);

export async function loadLookups(
  tx: Tx,
  schema: string,
  auth: AuthContext,
  rows: ParsedRow[],
): Promise<Lookups> {
  const skus = unique(rows.map((r) => r.sku && lower(r.sku)));
  const categories = unique(rows.map((r) => r.category && lower(r.category)));
  const warehouseCodes = unique(
    rows.map((r) => r.warehouseCode && lower(r.warehouseCode)),
  );
  const warehouseNames = unique(
    rows.map((r) => r.warehouse && lower(r.warehouse)),
  );
  const locationCodes = unique([
    'default',
    ...rows.map((r) => r.locationCode && lower(r.locationCode)),
  ]);
  const lotCodes = unique(rows.map((r) => r.lotCode));

  // Units of measure: each code and its aliases (INV-BR-11).
  const unitRows = await tx.unitOfMeasure.findMany({ select: { code: true } });
  const units = new Map<string, string>();
  for (const { code } of unitRows) {
    units.set(fold(code), code);
    for (const alias of UNIT_ALIASES[code] ?? []) units.set(fold(alias), code);
  }

  const productRows =
    skus.length === 0
      ? []
      : await tx.$queryRawUnsafe<
          (Omit<
            ProductInfo,
            'lengthCm' | 'widthCm' | 'heightCm' | 'weightKg' | 'volumeL'
          > & {
            lengthCm: string | null;
            widthCm: string | null;
            heightCm: string | null;
            weightKg: string | null;
            volumeL: string | null;
          })[]
        >(
          `SELECT p."id", p."sku", p."name", p."description",
                  p."category_id" AS "categoryId", c."name" AS "categoryName",
                  u."code" AS "unitCode", p."tracks_lots" AS "tracksLots",
                  p."is_active" AS "isActive",
                  p."length_cm"::text AS "lengthCm", p."width_cm"::text AS "widthCm",
                  p."height_cm"::text AS "heightCm", p."weight_kg"::text AS "weightKg",
                  p."volume_l"::text AS "volumeL"
             FROM "${schema}"."products" p
             JOIN "${schema}"."categories" c ON c."id" = p."category_id"
             JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
            WHERE lower(p."sku") = ANY($1::text[])
            ORDER BY p."id"`,
          skus,
        );
  const products = new Map<string, ProductInfo>();
  for (const p of productRows) {
    // With case duplicates (possible before this module), the oldest wins.
    if (products.has(lower(p.sku))) continue;
    products.set(lower(p.sku), {
      ...p,
      lengthCm: decimal(p.lengthCm),
      widthCm: decimal(p.widthCm),
      heightCm: decimal(p.heightCm),
      weightKg: decimal(p.weightKg),
      volumeL: decimal(p.volumeL),
    });
  }

  const categoryRows =
    categories.length === 0
      ? []
      : await tx.$queryRawUnsafe<CategoryInfo[]>(
          `SELECT "id", "name", "is_active" AS "isActive"
             FROM "${schema}"."categories" WHERE lower("name") = ANY($1::text[])
            ORDER BY "id"`,
          categories,
        );
  const categoryMap = new Map<string, CategoryInfo[]>();
  for (const c of categoryRows) {
    const key = lower(c.name);
    categoryMap.set(key, [...(categoryMap.get(key) ?? []), c]);
  }

  const warehouseRows =
    warehouseCodes.length + warehouseNames.length === 0
      ? []
      : await tx.$queryRawUnsafe<WarehouseInfo[]>(
          `SELECT "id", "code", "name", "is_active" AS "isActive",
                  "holds_stock" AS "holdsStock", "default_location_id" AS "defaultLocationId"
             FROM "${schema}"."warehouses"
            WHERE lower("code") = ANY($1::text[]) OR lower("name") = ANY($2::text[])
            ORDER BY "id"`,
          warehouseCodes,
          warehouseNames,
        );
  const warehousesByCode = new Map<string, WarehouseInfo>();
  const warehousesByName = new Map<string, WarehouseInfo>();
  for (const w of warehouseRows) {
    if (!warehousesByCode.has(lower(w.code))) {
      warehousesByCode.set(lower(w.code), w);
    }
    if (!warehousesByName.has(lower(w.name))) {
      warehousesByName.set(lower(w.name), w);
    }
  }
  const warehouseIds = warehouseRows.map((w) => w.id);
  const productIds = [...products.values()].map((p) => p.id);

  const defaults =
    warehouseIds.length === 0 || productIds.length === 0
      ? []
      : await tx.productWarehouse.findMany({
          where: {
            productId: { in: productIds },
            warehouseId: { in: warehouseIds },
          },
          select: {
            productId: true,
            warehouseId: true,
            defaultLocationId: true,
          },
        });
  const productDefaults = new Map(
    defaults.map((d) => [
      `${d.productId}:${d.warehouseId}`,
      d.defaultLocationId,
    ]),
  );
  const defaultLocationIds = [
    ...warehouseRows.map((w) => w.defaultLocationId),
    ...defaults.map((d) => d.defaultLocationId),
  ].filter((id): id is number => id !== null);

  const locationRows =
    warehouseIds.length === 0
      ? []
      : await tx.$queryRawUnsafe<(LocationInfo & { warehouseId: number })[]>(
          `SELECT "id", "warehouse_id" AS "warehouseId", "code", "is_active" AS "isActive"
             FROM "${schema}"."locations"
            WHERE "warehouse_id" = ANY($1::int[])
              AND (lower("code") = ANY($2::text[]) OR "id" = ANY($3::int[]))`,
          warehouseIds,
          locationCodes,
          defaultLocationIds,
        );
  const locations = new Map<string, LocationInfo>();
  for (const l of locationRows) {
    locations.set(`${l.warehouseId}:${lower(l.code)}`, {
      id: l.id,
      code: l.code,
      isActive: l.isActive,
    });
  }

  const lotRows =
    productIds.length === 0 || lotCodes.length === 0
      ? []
      : await tx.lot.findMany({
          where: { productId: { in: productIds }, code: { in: lotCodes } },
          select: {
            id: true,
            productId: true,
            code: true,
            manufactureDate: true,
            expiryDate: true,
          },
        });
  const lots = new Map(
    lotRows.map((l) => [
      `${l.productId}:${l.code}`,
      {
        id: l.id,
        code: l.code,
        manufactureDate: day(l.manufactureDate),
        expiryDate: day(l.expiryDate),
      },
    ]),
  );

  // Every product + location + lot that ever had a balance or a movement line.
  const usedRows =
    productIds.length === 0
      ? []
      : await tx.$queryRawUnsafe<
          { productId: number; locationId: number; lotId: number | null }[]
        >(
          `SELECT pw."product_id" AS "productId", sb."location_id" AS "locationId", sb."lot_id" AS "lotId"
             FROM "${schema}"."stock_balances" sb
             JOIN "${schema}"."product_warehouses" pw ON pw."id" = sb."product_warehouse_id"
            WHERE pw."product_id" = ANY($1::int[])
           UNION
           SELECT "product_id", "origin_location_id", "lot_id"
             FROM "${schema}"."movement_lines"
            WHERE "product_id" = ANY($1::int[]) AND "origin_location_id" IS NOT NULL
           UNION
           SELECT "product_id", "destination_location_id", "lot_id"
             FROM "${schema}"."movement_lines"
            WHERE "product_id" = ANY($1::int[]) AND "destination_location_id" IS NOT NULL`,
          productIds,
        );
  const usedIdentities = new Set(
    usedRows.map((u) => `${u.productId}:${u.locationId}:${u.lotId ?? ''}`),
  );

  return {
    units,
    products,
    categories: categoryMap,
    warehousesByCode,
    warehousesByName,
    locations,
    productDefaults,
    lots,
    usedIdentities,
    scope: importScope(auth),
  };
}
