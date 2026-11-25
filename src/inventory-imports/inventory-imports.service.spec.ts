import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import 'reflect-metadata';
import type { AuthContext } from '../auth/auth-context.js';
import { PERMISSIONS_KEY } from '../auth/decorators.js';
import type { CreateInventoryImportDto } from './dto.js';
import { InventoryImportConfig } from './inventory-import-config.js';
import { INVENTORY_IMPORT } from './inventory-import-access.js';
import { InventoryImportsController } from './inventory-imports.controller.js';
import {
  canSee,
  fingerprint,
  InventoryImportsService,
} from './inventory-imports.service.js';

const owner: AuthContext = {
  account: { id: 1, email: 'owner@demo.co', name: 'Owner' },
  organization: {
    id: 10,
    subdomain: 'demo',
    legalName: 'Demo SAS',
    schemaName: 'tenant_demo',
  },
  user: {
    id: 1,
    jobTitle: null,
    roles: [
      {
        id: 1,
        name: 'Owner',
        isSystem: true,
        warehouse: null,
        permissions: [INVENTORY_IMPORT],
      },
    ],
  },
};

const valid: CreateInventoryImportDto = {
  clientRequestId: '6f1c2d4e-8a7b-4c1d-9e2f-3a4b5c6d7e8f',
  schemaVersion: 1,
  fileName: 'inventario.xlsx',
  sheetName: 'Inventario',
  totalRows: 10,
  mapping: {
    sku: { column: 1, header: 'Código producto *' },
    name: { column: 2, header: 'Producto *' },
    category: { column: 3, header: 'Categoría *' },
    stockUnit: { column: 4, header: 'Unidad de medida *' },
    warehouse: { column: 5, header: 'Bodega *' },
    tracksLots: { column: 6, header: 'Seguimiento *' },
    stockQuantity: { column: 7, header: 'Saldo inicial *' },
  },
};

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function service() {
  const client = vi.fn();
  const config = new InventoryImportConfig({
    get: () => undefined,
  } as unknown as ConfigService);
  return {
    client,
    service: new InventoryImportsService(
      { client } as never,
      {} as never,
      config,
      {} as never,
    ),
  };
}

describe('InventoryImportsService.create: request checks', () => {
  it.each([
    ['UNSUPPORTED_SCHEMA_VERSION', { schemaVersion: 2 }],
    ['MAPPING_INVALID', { mapping: { sku: null } }],
    ['IMPORT_LIMIT_EXCEEDED', { totalRows: 5001 }],
  ])('answers %s before touching the database', async (code, change) => {
    const { client, service: imports } = service();
    expect(
      await errorCode(imports.create(owner, { ...valid, ...change })),
    ).toBe(code);
    expect(client).not.toHaveBeenCalled();
  });
});

describe('fingerprint', () => {
  it('ignores the order of object keys', () => {
    expect(fingerprint({ a: 1, b: { c: [1, 2], d: null } })).toBe(
      fingerprint({ b: { d: null, c: [1, 2] }, a: 1 }),
    );
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe('canSee', () => {
  const record = (createdById: number, warehouseIds?: number[]) => ({
    createdById,
    summary: warehouseIds ? { warehouseIds } : null,
  });

  it('shows an import to its creator and to the Owner', () => {
    expect(canSee(record(5), 5, [])).toBe(true);
    expect(canSee(record(5), 1, 'ALL')).toBe(true);
  });

  it('shows it to others only with the permission in every warehouse it touches', () => {
    expect(canSee(record(5, [1, 2]), 6, [1, 2, 3])).toBe(true);
    expect(canSee(record(5, [1, 2]), 6, [1])).toBe(false);
    expect(canSee(record(5), 6, [1])).toBe(false);
    expect(canSee(record(5, []), 6, [1])).toBe(false);
  });
});

describe('InventoryImportsController', () => {
  it('requires inventory.import on every route', () => {
    const handlers = Object.getOwnPropertyNames(
      InventoryImportsController.prototype,
    ).filter((name) => name !== 'constructor');
    expect(handlers.sort()).toEqual([
      'appendRows',
      'cancel',
      'confirm',
      'create',
      'fields',
      'get',
      'issues',
      'list',
      'previewRows',
      'validate',
    ]);
    for (const name of handlers) {
      const handler = (
        InventoryImportsController.prototype as unknown as Record<
          string,
          object
        >
      )[name];
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
        INVENTORY_IMPORT,
      ]);
    }
  });
});
