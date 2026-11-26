// Writes a validated plan inside the confirmation's transaction
// (docs/modules/inventary.md, "Confirmation transaction"). Stock goes through
// MovementsService.record(), the same engine as every movement, so balances,
// average costs and alerts follow the existing rules.
import type { AuthContext } from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type {
  MovementsService,
  PlannedLine,
} from '../movements/movements.service.js';
import { createWarehouseWithDefaultLocation } from '../warehouses/warehouses.service.js';
import { assignCreatorToWarehouse } from './inventory-import-access.js';
import type { ParsedRow } from './parse.js';
import { type ImportPlan, lower, type Ref } from './validate.js';

type Tx = Prisma.TransactionClient;

/** Lines per opening movement (movement_lines.line_number is a smallint). */
export const LINES_PER_MOVEMENT = 1000;

const unique = (values: (string | undefined)[]) => [
  ...new Set(values.filter((v): v is string => v !== undefined)),
];

/**
 * Locks what the rows depend on, in the order ordinary operations take them:
 * the warehouses and categories they name (shared, so nobody changes them while
 * the import reads them), then the products (`FOR UPDATE` in id order, the lock
 * every movement takes).
 */
export async function lockDependencies(
  tx: Tx,
  schema: string,
  rows: ParsedRow[],
) {
  const codes = unique(
    rows.map((r) => r.warehouseCode && lower(r.warehouseCode)),
  );
  const names = unique(rows.map((r) => r.warehouse && lower(r.warehouse)));
  const categories = unique(rows.map((r) => r.category && lower(r.category)));
  const skus = unique(rows.map((r) => r.sku && lower(r.sku)));
  await tx.$executeRawUnsafe(
    `SELECT 1 FROM "${schema}"."warehouses"
      WHERE lower("code") = ANY($1::text[]) OR lower("name") = ANY($2::text[])
      ORDER BY "id" FOR SHARE`,
    codes,
    names,
  );
  await tx.$executeRawUnsafe(
    `SELECT 1 FROM "${schema}"."categories" WHERE lower("name") = ANY($1::text[])
      ORDER BY "id" FOR SHARE`,
    categories,
  );
  await tx.$executeRawUnsafe(
    `SELECT 1 FROM "${schema}"."products" WHERE lower("sku") = ANY($1::text[])
      ORDER BY "id" FOR UPDATE`,
    skus,
  );
}

export interface AppliedPlan {
  stockRows: number;
  movements: number;
  created: {
    categories: number;
    products: number;
    warehouses: number;
    lots: number;
  };
  assignedWarehouses: number;
  /** Warehouses created by the import. */
  newWarehouseIds: number[];
}

/**
 * Creates the plan's categories, warehouses, products and lots, then records
 * its stock as "Opening balance" movements linked to the import, at most
 * `LINES_PER_MOVEMENT` lines each, per warehouse.
 */
export async function applyPlan(
  tx: Tx,
  schema: string,
  auth: AuthContext,
  importId: number,
  plan: ImportPlan,
  movements: MovementsService,
): Promise<AppliedPlan> {
  const id = (ref: Ref, created: Map<string, number>) =>
    'id' in ref ? ref.id : created.get(ref.key)!;

  // Categories (top level, INV-BR-05).
  const categoryIds = new Map<string, number>();
  if (plan.categories.length > 0) {
    const rows = await tx.category.createManyAndReturn({
      data: plan.categories.map((c) => ({ name: c.name, parentId: null })),
      select: { id: true, name: true },
    });
    const byName = new Map(rows.map((r) => [lower(r.name), r.id]));
    for (const c of plan.categories) {
      categoryIds.set(c.key, byName.get(lower(c.name))!);
    }
  }

  // Warehouses with their DEFAULT location, and the creator's assignment.
  const warehouseIds = new Map<string, number>();
  const defaults = new Map<number, number | null>();
  let assignedWarehouses = 0;
  for (const w of plan.warehouses) {
    const created = await createWarehouseWithDefaultLocation(tx, {
      code: w.code,
      name: w.name,
      type: w.type,
      address: w.address,
      holdsStock: true,
    });
    warehouseIds.set(w.key, created.id);
    warehouseIds.set(`location:${w.key}`, created.defaultLocationId!);
    defaults.set(created.id, created.defaultLocationId);
    if ((await assignCreatorToWarehouse(tx, auth, created.id)) > 0) {
      assignedWarehouses++;
    }
  }

  // Products.
  const productIds = new Map<string, number>();
  if (plan.products.length > 0) {
    const units = await tx.unitOfMeasure.findMany({
      select: { id: true, code: true },
    });
    const unitId = new Map(units.map((u) => [u.code, u.id]));
    const rows = await tx.product.createManyAndReturn({
      data: plan.products.map((p) => ({
        sku: p.sku,
        name: p.name,
        categoryId: id(p.category, categoryIds),
        stockUnitId: unitId.get(p.unitCode)!,
        tracksLots: p.tracksLots,
        description: p.description,
        lengthCm: p.lengthCm,
        widthCm: p.widthCm,
        heightCm: p.heightCm,
        weightKg: p.weightKg,
        volumeL: p.volumeL,
      })),
      select: { id: true, sku: true },
    });
    const bySku = new Map(rows.map((r) => [lower(r.sku), r.id]));
    for (const p of plan.products)
      productIds.set(p.key, bySku.get(lower(p.sku))!);
  }

  // Lots, with the file's dates (record() then finds them by code).
  if (plan.lots.length > 0) {
    await tx.lot.createMany({
      data: plan.lots.map((l) => ({
        productId: id(l.product, productIds),
        code: l.code,
        manufactureDate: l.manufactureDate
          ? new Date(`${l.manufactureDate}T00:00:00Z`)
          : null,
        expiryDate: l.expiryDate ? new Date(`${l.expiryDate}T00:00:00Z`) : null,
      })),
    });
  }

  // Stock, through the movement engine.
  const type = await tx.movementType.findFirst({
    where: { name: 'Opening balance', isBase: true, nature: 'INBOUND' },
    select: { id: true },
  });
  if (!type)
    throw new Error('The base movement type "Opening balance" is missing');

  const lineProductIds = plan.lines.map((l) => id(l.product, productIds));
  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(lineProductIds)] } },
    select: { id: true, sku: true },
  });
  const skus = new Map(products.map((p) => [p.id, p.sku]));
  const existingLots = plan.lines.flatMap((l) =>
    l.lot && 'id' in l.lot ? [l.lot.id] : [],
  );
  const lotCodes = new Map(
    (existingLots.length === 0
      ? []
      : await tx.lot.findMany({
          where: { id: { in: [...new Set(existingLots)] } },
          select: { id: true, code: true },
        })
    ).map((l) => [l.id, l.code]),
  );
  const newLotCodes = new Map(plan.lots.map((l) => [l.key, l.code]));
  const existingWarehouses = [
    ...new Set(
      plan.lines.flatMap((l) => ('id' in l.warehouse ? [l.warehouse.id] : [])),
    ),
  ];
  for (const w of existingWarehouses.length === 0
    ? []
    : await tx.warehouse.findMany({
        where: { id: { in: existingWarehouses } },
        select: { id: true, defaultLocationId: true },
      })) {
    defaults.set(w.id, w.defaultLocationId);
  }

  const planned: { warehouseId: number; line: PlannedLine }[] = plan.lines.map(
    (line, index) => {
      const productId = lineProductIds[index];
      return {
        warehouseId: id(line.warehouse, warehouseIds),
        line: {
          lineNumber: 0,
          product: { id: productId, sku: skus.get(productId)! },
          effect: 'IN',
          quantity: new Prisma.Decimal(line.quantity),
          locationId: id(line.location, warehouseIds),
          lotCode: line.lot
            ? 'id' in line.lot
              ? lotCodes.get(line.lot.id)
              : newLotCodes.get(line.lot.key)
            : undefined,
          unitCost:
            line.unitCost === null
              ? undefined
              : new Prisma.Decimal(line.unitCost),
        },
      };
    },
  );

  // Lines with a cost first, in every warehouse: a line without one then takes
  // the average the file's own costs produced, not 0 (INV-BR-01, INV-BR-13).
  let movementCount = 0;
  for (const withCost of [true, false]) {
    const byWarehouse = new Map<number, PlannedLine[]>();
    for (const { warehouseId, line } of planned) {
      if ((line.unitCost !== undefined) !== withCost) continue;
      const list = byWarehouse.get(warehouseId);
      if (list) list.push(line);
      else byWarehouse.set(warehouseId, [line]);
    }
    for (const [warehouseId, lines] of byWarehouse) {
      for (let i = 0; i < lines.length; i += LINES_PER_MOVEMENT) {
        const chunk = lines
          .slice(i, i + LINES_PER_MOVEMENT)
          .map((line, index) => ({ ...line, lineNumber: index + 1 }));
        await movements.record(tx, schema, {
          movementTypeId: type.id,
          registeredById: auth.user.id,
          warehouse: {
            id: warehouseId,
            defaultLocationId: defaults.get(warehouseId) ?? null,
          },
          lines: chunk,
          allowNegative: false,
          documentRef: `INV-IMP-${importId}`,
          inventoryImportId: importId,
        });
        movementCount++;
      }
    }
  }

  return {
    stockRows: plan.lines.length,
    movements: movementCount,
    created: {
      categories: plan.categories.length,
      products: plan.products.length,
      warehouses: plan.warehouses.length,
      lots: plan.lots.length,
    },
    assignedWarehouses,
    newWarehouseIds: [...warehouseIds.entries()]
      .filter(([key]) => !key.startsWith('location:'))
      .map(([, value]) => value),
  };
}
