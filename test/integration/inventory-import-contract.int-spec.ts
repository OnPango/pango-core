// INV-016: the documented contract against the running API. Every response of
// every route is checked against its OpenAPI schema (no undocumented field, no
// missing required field), and the routes and error statuses OpenAPI declares are
// the ones the module implements. With CONTRACT_EXAMPLES_OUT set, the real
// responses are written there to refresh the examples of docs/modules/inventary.md.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import request from 'supertest';
import type { PrismaClient } from '../../src/generated/prisma/tenant/client.js';
import {
  createWarehouse,
  provisionTenant,
  tenantClient,
  type TestTenant,
} from './database.js';
import { bootApp } from './http-app.js';

/**
 * Fields of an error body: Pango's shared envelope, ValidationPipe's `error`,
 * and the extras this module documents.
 */
const ERROR_FIELDS = [
  'statusCode',
  'code',
  'message',
  'error',
  'problems',
  'importId',
  'receivedRows',
  'totalRows',
];

const TENANT = 'contract';

type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
};

describe('the inventory import contract matches the running API', () => {
  let app: NestExpressApplication;
  let tenant: TestTenant;
  let db: PrismaClient;
  let token: string;
  let openApi: OpenAPIObject;
  const examples: Record<string, unknown> = {};

  const call = (method: 'get' | 'post', path: string) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant', TENANT);

  const resolve = (schema: Schema): Schema => {
    if (schema.$ref) {
      const name = schema.$ref.split('/').pop()!;
      return resolve(openApi.components!.schemas![name] as Schema);
    }
    if (schema.allOf) {
      const parts = schema.allOf.map(resolve);
      return {
        type: 'object',
        properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
        required: parts.flatMap((p) => p.required ?? []),
      };
    }
    return schema;
  };

  /** Every object field documented, every required field present, recursively. */
  const conform = (value: unknown, schema: Schema, at: string): string[] => {
    const resolved = resolve(schema);
    if (value === null || value === undefined) return [];
    if (resolved.type === 'array' && resolved.items && Array.isArray(value)) {
      return value
        .slice(0, 3)
        .flatMap((v, i) => conform(v, resolved.items!, `${at}[${i}]`));
    }
    if (!resolved.properties || typeof value !== 'object') return [];
    const problems: string[] = [];
    const actual = Object.keys(value as object);
    for (const key of actual) {
      if (!(key in resolved.properties))
        problems.push(`${at}.${key} is not documented`);
    }
    for (const key of resolved.required ?? []) {
      if (!actual.includes(key))
        problems.push(`${at}.${key} is required but missing`);
    }
    for (const key of actual) {
      const child = resolved.properties[key];
      if (child)
        problems.push(
          ...conform(
            (value as Record<string, unknown>)[key],
            child,
            `${at}.${key}`,
          ),
        );
    }
    return problems;
  };

  /** Checks a response against the schema OpenAPI documents for it, and keeps it as an example. */
  const check = (
    name: string,
    method: 'get' | 'post',
    template: string,
    response: request.Response,
  ) => {
    const operation = (openApi.paths[template] as Record<string, any>)?.[
      method
    ];
    expect(
      operation,
      `${method.toUpperCase()} ${template} is documented`,
    ).toBeDefined();
    const documented = operation.responses[String(response.status)];
    expect(
      documented,
      `${template} documents status ${response.status}`,
    ).toBeDefined();
    const schema = documented.content?.['application/json']?.schema as
      Schema | undefined;
    if (response.status >= 400) {
      // Pango's shared error envelope, plus only the extras this module documents.
      const body = response.body as Record<string, unknown>;
      expect(body).toHaveProperty('statusCode', response.status);
      expect(body).toHaveProperty('message');
      for (const key of Object.keys(body)) {
        expect(
          ERROR_FIELDS,
          `${name}.${key} is a documented error field`,
        ).toContain(key);
      }
    } else if (schema) {
      expect(conform(response.body, schema, name)).toEqual([]);
    }
    examples[name] = response.body;
  };

  beforeAll(async () => {
    tenant = await provisionTenant(TENANT);
    db = tenantClient(tenant.schema);
    await createWarehouse(db, 'NORTE');
    let tokens;
    ({ app, tokens } = await bootApp());
    token = await tokens.signAccessToken({
      accountId: tenant.accountId,
      organizationId: tenant.organizationId,
    });
    openApi = SwaggerModule.createDocument(app, new DocumentBuilder().build());
  });

  afterAll(async () => {
    if (process.env.CONTRACT_EXAMPLES_OUT) {
      writeFileSync(
        process.env.CONTRACT_EXAMPLES_OUT,
        JSON.stringify(examples, null, 2),
      );
    }
    await app?.close();
    await db?.$disconnect();
  });

  it('documents exactly the routes the module serves', () => {
    const routes = Object.entries(openApi.paths)
      .filter(([path]) => path.startsWith('/inventory-imports'))
      .flatMap(([path, operations]) =>
        Object.keys(operations as object).map(
          (m) => `${m.toUpperCase()} ${path}`,
        ),
      )
      .sort();
    expect(routes).toEqual([
      'GET /inventory-imports',
      'GET /inventory-imports/fields',
      'GET /inventory-imports/{id}',
      'GET /inventory-imports/{id}/issues',
      'GET /inventory-imports/{id}/rows',
      'POST /inventory-imports',
      'POST /inventory-imports/{id}/cancel',
      'POST /inventory-imports/{id}/confirm',
      'POST /inventory-imports/{id}/rows',
      'POST /inventory-imports/{id}/validate',
    ]);
  });

  it('answers every route as documented, from creation to confirmation', async () => {
    check(
      'fields',
      'get',
      '/inventory-imports/fields',
      await call('get', '/inventory-imports/fields').expect(200),
    );

    const creation = {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'inventario-noviembre.xlsx',
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
        lotCode: { column: 9, header: 'Código de lote **' },
      },
    };
    const created = await call('post', '/inventory-imports')
      .send(creation)
      .expect(201);
    check('create', 'post', '/inventory-imports', created);
    const id = created.body.id as number;
    check(
      'createReplay',
      'post',
      '/inventory-imports',
      await call('post', '/inventory-imports').send(creation).expect(200),
    );

    const values = (sku: string, extra: Record<string, string> = {}) => ({
      sku,
      name: 'Tornillo hexagonal',
      category: 'Tornillería',
      stockUnit: 'Unidad',
      warehouse: 'NORTE',
      tracksLots: 'Cantidad',
      stockQuantity: '500',
      unitCost: '350',
      ...extra,
    });
    const batch = {
      batchNumber: 1,
      rows: [
        { rowNumber: 2, values: values('TOR-001') },
        { rowNumber: 3, values: values('TOR-002', { unitCost: '' }) },
      ],
    };
    check(
      'rows',
      'post',
      '/inventory-imports/{id}/rows',
      await call('post', `/inventory-imports/${id}/rows`)
        .send(batch)
        .expect(200),
    );
    check(
      'rowsReplay',
      'post',
      '/inventory-imports/{id}/rows',
      await call('post', `/inventory-imports/${id}/rows`)
        .send(batch)
        .expect(200),
    );
    check(
      'incomplete',
      'post',
      '/inventory-imports/{id}/validate',
      await call('post', `/inventory-imports/${id}/validate`).expect(409),
    );
    await call('post', `/inventory-imports/${id}/rows`)
      .send({
        batchNumber: 2,
        rows: [{ rowNumber: 4, values: values('TOR-001') }],
      })
      .expect(200);

    check(
      'validate',
      'post',
      '/inventory-imports/{id}/validate',
      await call('post', `/inventory-imports/${id}/validate`).expect(200),
    );
    check(
      'previewRows',
      'get',
      '/inventory-imports/{id}/rows',
      await call('get', `/inventory-imports/${id}/rows?pageSize=2`).expect(200),
    );
    check(
      'issues',
      'get',
      '/inventory-imports/{id}/issues',
      await call('get', `/inventory-imports/${id}/issues`).expect(200),
    );
    // Rows 2 and 4 are the same identity with identical values: counted once.
    check(
      'confirm',
      'post',
      '/inventory-imports/{id}/confirm',
      await call('post', `/inventory-imports/${id}/confirm`)
        .send({ revision: 1 })
        .expect(200),
    );
    check(
      'get',
      'get',
      '/inventory-imports/{id}',
      await call('get', `/inventory-imports/${id}`).expect(200),
    );
    check(
      'list',
      'get',
      '/inventory-imports',
      await call('get', '/inventory-imports').expect(200),
    );
    check(
      'closed',
      'post',
      '/inventory-imports/{id}/cancel',
      await call('post', `/inventory-imports/${id}/cancel`).expect(409),
    );

    const other = await call('post', '/inventory-imports')
      .send({ ...creation, clientRequestId: randomUUID() })
      .expect(201);
    check(
      'cancel',
      'post',
      '/inventory-imports/{id}/cancel',
      await call('post', `/inventory-imports/${other.body.id}/cancel`).expect(
        200,
      ),
    );
  });

  it('answers errors with the documented statuses and codes', async () => {
    const base = {
      clientRequestId: randomUUID(),
      schemaVersion: 1,
      fileName: 'f.xlsx',
      sheetName: 'Inventario',
      totalRows: 1,
    };
    check(
      'validationError',
      'post',
      '/inventory-imports',
      await call('post', '/inventory-imports')
        .send({ ...base, mapping: {}, extra: 1 })
        .expect(400),
    );
    const mapping = await call('post', '/inventory-imports')
      .send({ ...base, mapping: { sku: null } })
      .expect(400);
    expect(mapping.body.code).toBe('MAPPING_INVALID');
    check('mappingInvalid', 'post', '/inventory-imports', mapping);
    const tooBig = await call('post', '/inventory-imports')
      .send({
        ...base,
        totalRows: 5001,
        mapping: {
          sku: { column: 1, header: 'a' },
          name: { column: 2, header: 'b' },
          category: { column: 3, header: 'c' },
          stockUnit: { column: 4, header: 'd' },
          warehouse: { column: 5, header: 'e' },
          tracksLots: { column: 6, header: 'f' },
          stockQuantity: { column: 7, header: 'g' },
        },
      })
      .expect(413);
    check('limitExceeded', 'post', '/inventory-imports', tooBig);
    const missing = await call('get', '/inventory-imports/999999').expect(404);
    expect(missing.body.code).toBe('IMPORT_NOT_FOUND');
    check('notFound', 'get', '/inventory-imports/{id}', missing);
  });
});
