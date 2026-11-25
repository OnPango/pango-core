// End to end over HTTP: the whole Pango app (guards, pipes, controllers) against
// the local test database, configured as src/main.ts configures it.
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import {
  provisionTenant,
  tenantClient,
  testDatabaseUrl,
  type TestTenant,
} from './database.js';
import { bootApp } from './http-app.js';

const TENANT = 'http-e2e';

describe('inventory import over HTTP', () => {
  let app: NestExpressApplication;
  let tenant: TestTenant;
  let db: PrismaClient;
  let ownerToken: string;
  let operatorToken: string;

  const call = (method: 'get' | 'post', path: string, token = ownerToken) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant', TENANT);

  beforeAll(async () => {
    tenant = await provisionTenant(TENANT);
    db = tenantClient(tenant.schema);

    ({ app } = await bootApp());

    const { TokenService } = await import('../../src/auth/token.service.js');
    const tokens = app.get(TokenService);
    ownerToken = await tokens.signAccessToken({
      accountId: tenant.accountId,
      organizationId: tenant.organizationId,
    });

    // An Operator: a member without `inventory.import`.
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    const {
      rows: [account],
    } = await client.query<{ id: number }>(
      `INSERT INTO "public"."accounts" ("email", "name", "email_verified_at")
       VALUES ('operator@http-e2e.test', 'Operator', now()) RETURNING "id"`,
    );
    await client.query(
      `INSERT INTO "public"."organization_members" ("account_id", "organization_id", "status", "joined_at")
       VALUES ($1, $2, 'ACTIVE', now())`,
      [account.id, tenant.organizationId],
    );
    await client.end();
    const operator = await db.user.create({ data: { accountId: account.id } });
    const operatorRole = await db.role.findUniqueOrThrow({
      where: { name: 'Operator' },
    });
    await db.roleAssignment.create({
      data: { userId: operator.id, roleId: operatorRole.id, warehouseId: null },
    });
    operatorToken = await tokens.signAccessToken({
      accountId: account.id,
      organizationId: tenant.organizationId,
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  it('runs the whole import, and the rest of Pango sees the opening', async () => {
    // Existing data through Pango's own routes (regression of the touched modules).
    const warehouse = await call('post', '/warehouses')
      .send({ code: 'NORTE', name: 'Norte', type: 'WAREHOUSE' })
      .expect(201);
    expect(warehouse.body.defaultLocation).toMatchObject({ code: 'DEFAULT' });
    const north = warehouse.body.id as number;
    const category = await call('post', '/categories')
      .send({ name: 'Herramientas' })
      .expect(201);
    const units = await call('get', '/units-of-measure').expect(200);
    const each = (units.body as { id: number; code: string }[]).find(
      (u) => u.code === 'EA',
    )!;
    const bolt = await call('post', '/products')
      .send({
        sku: 'TOR-001',
        name: 'Tornillo',
        categoryId: category.body.id,
        stockUnitId: each.id,
      })
      .expect(201);
    const types = await call('get', '/movement-types').expect(200);
    const purchase = (types.body as { id: number; name: string }[]).find(
      (t) => t.name === 'Purchase receipt',
    )!;
    const bought = await call('post', '/movements')
      .send({
        movementTypeId: purchase.id,
        warehouseId: north,
        lines: [{ productId: bolt.body.id, quantity: 50, unitCost: 10 }],
      })
      .expect(201);
    expect(bought.body.status).toBe('CONFIRMED');

    // The import.
    const fields = await call('get', '/inventory-imports/fields').expect(200);
    expect(fields.body.fields).toHaveLength(21);
    expect(fields.body.limits).toMatchObject({
      maxRowsPerImport: 5000,
      maxRowChars: 4096,
    });

    const creation = {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'inventario.xlsx',
      sheetName: 'Inventario',
      totalRows: 3,
      mapping: {
        sku: { column: 1, header: 'Código producto *' },
        name: { column: 2, header: 'Producto *' },
        category: { column: 3, header: 'Categoría *' },
        stockUnit: { column: 4, header: 'Unidad de medida *' },
        warehouse: { column: 5, header: 'Bodega *' },
        tracksLots: { column: 6, header: 'Seguimiento *' },
        stockQuantity: { column: 7, header: 'Saldo inicial *' },
        unitCost: { column: 8, header: 'Costo unitario' },
      },
    };
    const created = await call('post', '/inventory-imports')
      .send(creation)
      .expect(201);
    const id = created.body.id as number;
    expect(created.body).toMatchObject({ status: 'RECEIVING', totalRows: 3 });
    const replayed = await call('post', '/inventory-imports')
      .send(creation)
      .expect(200);
    expect(replayed.body.id).toBe(id);

    const values = (sku: string, quantity: string, cost: string) => ({
      sku,
      name: sku === 'TOR-001' ? 'Tornillo' : 'Taladro',
      category: 'Herramientas',
      stockUnit: 'Unidad',
      warehouse: 'Norte',
      tracksLots: 'Cantidad',
      stockQuantity: quantity,
      unitCost: cost,
    });
    const batch1 = {
      batchNumber: 1,
      rows: [
        { rowNumber: 2, values: { ...values('NEW-1', '8', '100') } },
        { rowNumber: 3, values: { ...values('NEW-2', '4', '') } },
      ],
    };
    await call('post', `/inventory-imports/${id}/rows`)
      .send(batch1)
      .expect(200);
    const again = await call('post', `/inventory-imports/${id}/rows`)
      .send(batch1)
      .expect(200);
    expect(again.body).toMatchObject({ replayed: true, receivedRows: 2 });
    await call('post', `/inventory-imports/${id}/rows`)
      .send({
        batchNumber: 2,
        rows: [{ rowNumber: 4, values: values('TOR-001', '9', '20') }],
      })
      .expect(200);

    const report = await call(
      'post',
      `/inventory-imports/${id}/validate`,
    ).expect(200);
    // The bolt already has stock at Norte's DEFAULT: an opening cannot load it.
    expect(report.body.import).toMatchObject({
      status: 'INVALID',
      revision: 1,
    });
    expect(report.body.issues.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rowNumber: 4, code: 'ALREADY_HAS_STOCK' }),
        expect.objectContaining({
          rowNumber: 3,
          code: 'COST_MISSING',
          sourceColumn: { column: 8, header: 'Costo unitario' },
        }),
      ]),
    );
    const invalid = await call('post', `/inventory-imports/${id}/confirm`)
      .send({ revision: 1 })
      .expect(409);
    expect(invalid.body).toEqual({
      statusCode: 409,
      code: 'IMPORT_NOT_READY',
      message: expect.any(String),
    });

    // The user fixes the file and starts again.
    await call('post', `/inventory-imports/${id}/cancel`).expect(200);
    const second = await call('post', '/inventory-imports')
      .send({ ...creation, clientRequestId: randomUUID(), totalRows: 2 })
      .expect(201);
    const secondId = second.body.id as number;
    await call('post', `/inventory-imports/${secondId}/rows`)
      .send({ ...batch1 })
      .expect(200);
    const ready = await call(
      'post',
      `/inventory-imports/${secondId}/validate`,
    ).expect(200);
    expect(ready.body.import).toMatchObject({ status: 'READY', revision: 1 });

    const preview = await call(
      'get',
      `/inventory-imports/${secondId}/rows?status=VALID&pageSize=10`,
    ).expect(200);
    expect(preview.body).toMatchObject({ revision: 1, total: 2 });
    expect(preview.body.items[0]).toMatchObject({
      product: { isNew: true },
      warehouse: { id: north, isNew: false },
      quantity: '8',
    });
    const warnings = await call(
      'get',
      `/inventory-imports/${secondId}/issues?severity=WARNING`,
    ).expect(200);
    expect(warnings.body.items.map((i: { code: string }) => i.code)).toEqual([
      'COST_MISSING',
    ]);

    await call('post', `/inventory-imports/${secondId}/confirm`)
      .send({ revision: 2 })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('IMPORT_STALE'));
    const confirmed = await call(
      'post',
      `/inventory-imports/${secondId}/confirm`,
    )
      .send({ revision: 1 })
      .expect(200);
    expect(confirmed.body).toMatchObject({
      status: 'COMPLETED',
      result: { stockRows: 2, created: { products: 2 } },
    });
    await call('get', `/inventory-imports/${secondId}`)
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('COMPLETED'));
    const history = await call('get', '/inventory-imports').expect(200);
    expect(history.body.items.map((i: { id: number }) => i.id)).toEqual([
      secondId,
      id,
    ]);

    // Pango's own routes see the opening.
    const stock = await call('get', `/stock?warehouseId=${north}`).expect(200);
    const onHand = Object.fromEntries(
      (stock.body.items as { product: { sku: string }; onHand: number }[]).map(
        (i) => [i.product.sku, i.onHand],
      ),
    );
    expect(onHand).toEqual({ 'TOR-001': 50, 'NEW-1': 8, 'NEW-2': 4 });
    const products = await call('get', '/products?search=NEW').expect(200);
    const drill = (
      products.body.items as { id: number; sku: string; averageCost: number }[]
    ).find((p) => p.sku === 'NEW-1')!;
    expect(drill.averageCost).toBe(100);
    const movements = await call(
      'get',
      `/movements?warehouseId=${north}`,
    ).expect(200);
    const opening = (
      movements.body.items as {
        documentRef: string | null;
        movementType: { name: string; countsAsDemand: boolean };
      }[]
    ).filter((m) => m.documentRef === `INV-IMP-${secondId}`);
    expect(opening).toHaveLength(2);
    expect(opening[0].movementType).toMatchObject({
      name: 'Opening balance',
      countsAsDemand: false,
    });
    const demand = await call('get', `/products/${drill.id}/demand`).expect(
      200,
    );
    expect(demand.body.total).toBe(0);
  });

  it('answers errors in Pango’s envelope', async () => {
    const unknown = await call('post', '/inventory-imports')
      .send({
        clientRequestId: randomUUID(),
        schemaVersion: 1,
        fileName: 'f',
        sheetName: 's',
        totalRows: 1,
        mapping: {},
        extra: true,
      })
      .expect(400);
    expect(unknown.body.message).toEqual(
      expect.arrayContaining(['property extra should not exist']),
    );
    const missing = await call('get', '/inventory-imports/999999').expect(404);
    expect(missing.body).toEqual({
      statusCode: 404,
      code: 'IMPORT_NOT_FOUND',
      message: expect.any(String),
    });
    const mapping = await call('post', '/inventory-imports')
      .send({
        clientRequestId: randomUUID(),
        schemaVersion: 1,
        fileName: 'f',
        sheetName: 's',
        totalRows: 1,
        mapping: { sku: null },
      })
      .expect(400);
    expect(mapping.body.code).toBe('MAPPING_INVALID');
  });

  it('refuses users without inventory.import on every route', async () => {
    for (const [method, path] of [
      ['get', '/inventory-imports/fields'],
      ['get', '/inventory-imports'],
      ['post', '/inventory-imports'],
      ['get', '/inventory-imports/1'],
      ['post', '/inventory-imports/1/rows'],
      ['post', '/inventory-imports/1/validate'],
      ['get', '/inventory-imports/1/rows'],
      ['get', '/inventory-imports/1/issues'],
      ['post', '/inventory-imports/1/confirm'],
      ['post', '/inventory-imports/1/cancel'],
    ] as const) {
      const response = await call(method, path, operatorToken).send({});
      expect([path, response.status, response.body.code]).toEqual([
        path,
        403,
        'FORBIDDEN',
      ]);
    }
  });
});
