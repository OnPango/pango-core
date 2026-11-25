import { BadRequestException, ValidationPipe } from '@nestjs/common';
import 'reflect-metadata';
import { IS_PUBLIC_KEY } from '../auth/decorators.js';
import {
  AppendInventoryRowsDto,
  ConfirmInventoryImportDto,
  CreateInventoryImportDto,
  ListInventoryImportIssuesQueryDto,
} from './dto.js';
import { InventoryImportsController } from './inventory-imports.controller.js';

// The same pipe as src/main.ts: requests are checked before any handler runs.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const body = (metatype: new () => object, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype });

const valid = {
  clientRequestId: '6f1c2d4e-8a7b-4c1d-9e2f-3a4b5c6d7e8f',
  schemaVersion: 1,
  fileName: 'inventario.xlsx',
  sheetName: 'Inventario',
  totalRows: 10,
  mapping: {},
};

describe('inventory import requests are validated before the handlers', () => {
  it('accepts a well-formed creation', async () => {
    await expect(body(CreateInventoryImportDto, valid)).resolves.toMatchObject({
      totalRows: 10,
    });
  });

  it.each([
    ['an unknown field', { ...valid, organizationId: 7 }],
    ['a text number', { ...valid, totalRows: '10' }],
    ['a zero row count', { ...valid, totalRows: 0 }],
    ['a malformed request id', { ...valid, clientRequestId: 'abc' }],
    ['a mapping that is not an object', { ...valid, mapping: ['sku'] }],
    ['an empty file name', { ...valid, fileName: '' }],
  ])('refuses a creation with %s', async (_case, value) => {
    await expect(body(CreateInventoryImportDto, value)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never lets a prototype key through', async () => {
    const parsed = JSON.parse(
      `{"clientRequestId":"${valid.clientRequestId}","schemaVersion":1,"fileName":"f","sheetName":"s","totalRows":1,"mapping":{},"__proto__":{"isAdmin":true}}`,
    ) as object;
    const dto = (await body(CreateInventoryImportDto, parsed)) as object;
    expect(Object.getPrototypeOf(dto)).toBe(CreateInventoryImportDto.prototype);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it.each([
    ['rows that are not a list', { batchNumber: 1, rows: 'x' }],
    ['no rows', { batchNumber: 1, rows: [] }],
    ['a batch number of zero', { batchNumber: 0, rows: [{}] }],
    ['an unknown field', { batchNumber: 1, rows: [{}], importId: 3 }],
  ])('refuses a batch with %s', async (_case, value) => {
    await expect(body(AppendInventoryRowsDto, value)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a confirmation whose revision is not a positive integer', async () => {
    for (const revision of ['1', 0, 1.5, null]) {
      await expect(
        body(ConfirmInventoryImportDto, { revision }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('refuses issue filters outside their format', async () => {
    await expect(
      pipe.transform(
        { code: "x' OR 1=1 --" },
        { type: 'query', metatype: ListInventoryImportIssuesQueryDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { pageSize: '1000' },
        { type: 'query', metatype: ListInventoryImportIssuesQueryDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('has no public route: every one goes through the session guard', () => {
    for (const name of Object.getOwnPropertyNames(
      InventoryImportsController.prototype,
    )) {
      const handler = (
        InventoryImportsController.prototype as unknown as Record<
          string,
          object
        >
      )[name];
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, InventoryImportsController),
    ).toBeUndefined();
  });
});
