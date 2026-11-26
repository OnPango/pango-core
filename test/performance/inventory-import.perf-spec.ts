// INV-015 benchmark (docs/modules/inventary.md, "Performance"). Synthetic data
// only. Run with `pnpm test:perf` against the local test database; results are
// printed as `PERF {...}` lines.
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import pg from 'pg';
import { Prisma } from '../../src/generated/prisma/tenant/client.js';
import { InventoryImportConfig } from '../../src/inventory-imports/inventory-import-config.js';
import { InventoryImportsService } from '../../src/inventory-imports/inventory-imports.service.js';
import { MovementsService } from '../../src/movements/movements.service.js';
import { ControlPrismaService } from '../../src/prisma/control-prisma.service.js';
import { TenantPrismaService } from '../../src/prisma/tenant-prisma.service.js';
import {
  createWarehouse,
  provisionTenant,
  sessionFor,
  tenantClient,
  testDatabaseUrl,
} from '../integration/database.js';
import { startLatencyProxy } from './latency-proxy.js';

const MAX_REQUEST_BYTES = 1024 * 1024;

const mapping = {
  sku: { column: 1, header: 'Código producto *' },
  name: { column: 2, header: 'Producto *' },
  category: { column: 3, header: 'Categoría *' },
  stockUnit: { column: 4, header: 'Unidad de medida *' },
  warehouse: { column: 5, header: 'Bodega *' },
  tracksLots: { column: 6, header: 'Seguimiento *' },
  stockQuantity: { column: 7, header: 'Saldo inicial *' },
  unitCost: { column: 8, header: 'Costo unitario' },
  lotCode: { column: 9, header: 'Código de lote **' },
  expiryDate: { column: 12, header: 'Fecha vencimiento' },
  description: { column: 16, header: 'Descripción' },
};

const WAREHOUSES = ['NORTE', 'SUR', 'ESTE'];

/**
 * A mixed file: half the SKUs already exist (without stock), three warehouses,
 * 50 categories, a quarter of the rows lot-tracked with an expiry, one row in
 * ten without cost.
 */
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const lot = i % 4 === 0;
    return {
      rowNumber: i + 2,
      values: {
        sku: `SKU-${i}`,
        name: `Producto de prueba número ${i}`,
        category: `Categoría ${i % 50}`,
        stockUnit: 'ud',
        warehouse: WAREHOUSES[i % 3],
        tracksLots: lot ? 'Lote' : 'Cantidad',
        stockQuantity: String(10 + (i % 7)),
        ...(i % 10 === 0 ? {} : { unitCost: '1250.5' }),
        ...(lot ? { lotCode: `L-${i}`, expiryDate: '2027-12-31' } : {}),
        description: 'Artículo sintético para la medición de rendimiento',
      },
    };
  });
}

/** Splits rows into batches under the body limit (with a margin) and the row limit. */
function batches(all: ReturnType<typeof rows>, maxRows: number) {
  const out: ReturnType<typeof rows>[] = [];
  let current: ReturnType<typeof rows> = [];
  let bytes = 64;
  for (const row of all) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (current.length >= maxRows || bytes + size > MAX_REQUEST_BYTES * 0.9) {
      out.push(current);
      current = [];
      bytes = 64;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function run(count: number, roundTripMs: number) {
  const direct = new URL(testDatabaseUrl());
  const proxy =
    roundTripMs > 0
      ? await startLatencyProxy(
          { host: direct.hostname, port: Number(direct.port) },
          roundTripMs,
        )
      : null;
  const url = new URL(testDatabaseUrl());
  if (proxy) url.port = String(proxy.port);
  const config = {
    getOrThrow: () => url.toString(),
    // Generous limit: measure the real time, then compare with the threshold.
    get: (name: string) =>
      name === 'INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS' ? '900000' : undefined,
  } as unknown as ConfigService;
  const tenants = new TenantPrismaService(config);
  const control = new ControlPrismaService(config);
  const movements = new MovementsService(control, tenants);
  const imports = new InventoryImportsService(
    tenants,
    control,
    new InventoryImportConfig(config),
    movements,
  );

  const tenant = await provisionTenant(`perf-${count}-${roundTripMs}`);
  const db = tenantClient(tenant.schema);
  const warehouses: Awaited<ReturnType<typeof createWarehouse>>[] = [];
  for (const code of WAREHOUSES)
    warehouses.push(await createWarehouse(db, code));
  const owner = await sessionFor(db, tenant, tenant.userId);
  const unit = await db.unitOfMeasure.findUniqueOrThrow({
    where: { code: 'EA' },
  });
  const existing = await db.category.create({ data: { name: 'Existente' } });
  await db.product.createMany({
    data: Array.from({ length: Math.floor(count / 2) }, (_, i) => ({
      sku: `SKU-${i * 2}`,
      name: `Producto de prueba número ${i * 2}`,
      categoryId: existing.id,
      stockUnitId: unit.id,
      tracksLots: (i * 2) % 4 === 0,
    })),
  });
  // A product of another business, sold during the confirmation.
  const other = await db.product.create({
    data: {
      sku: 'OTRO-1',
      name: 'Otro',
      categoryId: existing.id,
      stockUnitId: unit.id,
    },
  });
  const [purchase, sale] = await Promise.all([
    db.movementType.findUniqueOrThrow({ where: { name: 'Purchase receipt' } }),
    db.movementType.findUniqueOrThrow({ where: { name: 'Sales issue' } }),
  ]);
  const line = (effect: 'IN' | 'OUT') => ({
    lineNumber: 1,
    product: other,
    effect,
    quantity: new Prisma.Decimal(1),
    unitCost: new Prisma.Decimal(1),
  });
  await db.$transaction((tx) =>
    movements.record(tx, tenant.schema, {
      movementTypeId: purchase.id,
      registeredById: tenant.userId,
      warehouse: warehouses[0],
      lines: [{ ...line('IN'), quantity: new Prisma.Decimal(100) }],
      allowNegative: false,
    }),
  );

  const file = rows(count);
  const { import: record } = await imports.create(owner, {
    clientRequestId: randomUUID(),
    schemaVersion: 1,
    fileName: 'perf.xlsx',
    sheetName: 'Inventario',
    totalRows: count,
    mapping,
  });
  const parts = batches(file, 5000);
  let maxBatchMs = 0;
  let maxBatchBytes = 0;
  const receiveStart = performance.now();
  for (const [index, part] of parts.entries()) {
    const body = { batchNumber: index + 1, rows: part };
    maxBatchBytes = Math.max(
      maxBatchBytes,
      Buffer.byteLength(JSON.stringify(body)),
    );
    const started = performance.now();
    await imports.appendRows(owner, record.id, body);
    maxBatchMs = Math.max(maxBatchMs, performance.now() - started);
  }
  const receiveMs = performance.now() - receiveStart;

  const validateStart = performance.now();
  const report = await imports.validate(owner, record.id);
  const validateMs = performance.now() - validateStart;
  if (report.import.status !== 'READY') {
    throw new Error(
      `Benchmark file did not validate: ${JSON.stringify(report.issues.items.slice(0, 3))}`,
    );
  }

  // Sample memory and the database connections the confirmation holds.
  const sampler = new pg.Client({ connectionString: testDatabaseUrl() });
  await sampler.connect();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  let maxBusyConnections = 0;
  let sampling = true;
  const sampling$ = (async () => {
    while (sampling) {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      const { rows: busy } = await sampler.query<{ n: number }>(
        `SELECT COUNT(*)::int AS "n" FROM pg_stat_activity
          WHERE "datname" = current_database() AND "pid" <> pg_backend_pid()
            AND "state" IN ('active', 'idle in transaction')`,
      );
      maxBusyConnections = Math.max(maxBusyConnections, busy[0].n);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  const confirmStart = performance.now();
  const confirmation = imports.confirm(owner, record.id, {
    revision: report.import.revision,
  });
  // A sale of another product, one second into the confirmation.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const saleStart = performance.now();
  await db.$transaction((tx) =>
    movements.record(tx, tenant.schema, {
      movementTypeId: sale.id,
      registeredById: tenant.userId,
      warehouse: warehouses[0],
      lines: [line('OUT')],
      allowNegative: false,
    }),
  );
  const otherSaleMs = performance.now() - saleStart;
  const done = await confirmation;
  const confirmMs = performance.now() - confirmStart;
  sampling = false;
  await sampling$;
  await sampler.end();

  const result = {
    rows: count,
    roundTripMs,
    batches: parts.length,
    maxBatchBytes,
    maxBatchMs: Math.round(maxBatchMs),
    receiveMs: Math.round(receiveMs),
    validateMs: Math.round(validateMs),
    confirmMs: Math.round(confirmMs),
    otherSaleMs: Math.round(otherSaleMs),
    rssGrowthMb: Math.round((rssPeak - rssBefore) / 1048576),
    // The sampler's own connection is excluded; the sale adds one while it runs.
    maxBusyConnections,
    status: done.status,
    movements: (done.result as { movements: number }).movements,
  };
  process.stderr.write(`PERF ${JSON.stringify(result)}\n`);

  await Promise.all([db.$disconnect(), tenants.onModuleDestroy()]);
  await control.$disconnect();
  await proxy?.close();
  return result;
}

const plan: [number, number][] = (
  process.env.PERF_PLAN ?? '1000:0,2500:0,5000:0,5000:1,1000:5,5000:5,1000:20'
)
  .split(',')
  .map((pair) => pair.split(':').map(Number) as [number, number]);

describe('inventory import performance', () => {
  it.each(plan)(
    '%i rows with %i ms of round trip',
    async (count, roundTripMs) => {
      const result = await run(count, roundTripMs);
      expect(result.status).toBe('COMPLETED');
    },
  );

  it('refuses a file above the row limit', async () => {
    const config = {
      getOrThrow: () => testDatabaseUrl(),
      get: () => undefined,
    } as unknown as ConfigService;
    const tenants = new TenantPrismaService(config);
    const control = new ControlPrismaService(config);
    const imports = new InventoryImportsService(
      tenants,
      control,
      new InventoryImportConfig(config),
      new MovementsService(control, tenants),
    );
    const tenant = await provisionTenant('perf-limit');
    const db = tenantClient(tenant.schema);
    const owner = await sessionFor(db, tenant, tenant.userId);
    await expect(
      imports.create(owner, {
        clientRequestId: randomUUID(),
        schemaVersion: 1,
        fileName: 'big.xlsx',
        sheetName: 'Inventario',
        totalRows: 5001,
        mapping,
      }),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_LIMIT_EXCEEDED' } });
    await db.$disconnect();
    await tenants.onModuleDestroy();
    await control.$disconnect();
  });
});
