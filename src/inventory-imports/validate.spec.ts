import { Prisma } from '../generated/prisma/tenant/client.js';
import { parseRow } from './parse.js';
import {
  type Lookups,
  type ProductInfo,
  validateRows,
  type WarehouseInfo,
} from './validate.js';

const NORTH: WarehouseInfo = {
  id: 1,
  code: 'NORTE',
  name: 'Norte',
  isActive: true,
  holdsStock: true,
  defaultLocationId: 11,
};
const SOUTH: WarehouseInfo = {
  ...NORTH,
  id: 2,
  code: 'SUR',
  name: 'Sur',
  defaultLocationId: 21,
};
const BOLT: ProductInfo = {
  id: 100,
  sku: 'TOR-001',
  name: 'Tornillo',
  description: null,
  categoryId: 7,
  categoryName: 'Tornillería',
  unitCode: 'EA',
  tracksLots: false,
  isActive: true,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  weightKg: null,
  volumeL: null,
};
const OIL: ProductInfo = {
  ...BOLT,
  id: 200,
  sku: 'ACE-001',
  name: 'Aceite',
  categoryId: 8,
  categoryName: 'Lubricantes',
  unitCode: 'LTR',
  tracksLots: true,
};

function lookups(overrides: Partial<Lookups> = {}): Lookups {
  return {
    units: new Map([
      ['ea', 'EA'],
      ['ud', 'EA'],
      ['unidad', 'EA'],
      ['ltr', 'LTR'],
      ['litro', 'LTR'],
    ]),
    products: new Map([
      ['tor-001', BOLT],
      ['ace-001', OIL],
    ]),
    categories: new Map([
      ['tornillería', [{ id: 7, name: 'Tornillería', isActive: true }]],
      ['lubricantes', [{ id: 8, name: 'Lubricantes', isActive: true }]],
      [
        'accesorios',
        [
          { id: 9, name: 'Accesorios', isActive: true },
          { id: 10, name: 'accesorios', isActive: true },
        ],
      ],
      ['viejos', [{ id: 12, name: 'Viejos', isActive: false }]],
    ]),
    warehousesByCode: new Map([
      ['norte', NORTH],
      ['sur', SOUTH],
    ]),
    warehousesByName: new Map([
      ['norte', NORTH],
      ['sur', SOUTH],
    ]),
    locations: new Map([
      ['1:default', { id: 11, code: 'DEFAULT', isActive: true }],
      ['1:a-01', { id: 12, code: 'A-01', isActive: true }],
      ['1:old', { id: 13, code: 'OLD', isActive: false }],
      ['2:default', { id: 21, code: 'DEFAULT', isActive: true }],
    ]),
    productDefaults: new Map(),
    lots: new Map([
      [
        '200:L-1',
        {
          id: 500,
          code: 'L-1',
          manufactureDate: '2026-01-01',
          expiryDate: '2027-01-01',
        },
      ],
    ]),
    usedIdentities: new Set(),
    scope: 'ALL',
    ...overrides,
  };
}

/** A complete row of an existing product in Norte; override any cell. */
const cells = (values: Record<string, string | null> = {}) => ({
  sku: 'TOR-001',
  name: 'Tornillo',
  category: 'Tornillería',
  stockUnit: 'ud',
  warehouse: 'Norte',
  tracksLots: 'Cantidad',
  stockQuantity: '10',
  unitCost: '350',
  ...values,
});

function run(rows: Record<string, string | null>[], data = lookups()) {
  return validateRows(
    rows.map((values, index) => parseRow(index + 2, values)),
    data,
  );
}

const codesOf = (result: ReturnType<typeof run>, row = 2) =>
  result.issues.filter((i) => i.rowNumber === row).map((i) => i.code);

describe('validateRows: a clean opening', () => {
  it('plans the stock of an existing product in an existing warehouse', () => {
    const result = run([cells()]);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      status: 'VALID',
      product: { id: 100, isNew: false },
      category: { id: 7, isNew: false },
      warehouse: { id: 1, code: 'NORTE', isNew: false },
      locationCode: 'DEFAULT',
      stockUnit: 'EA',
      quantity: '10',
      unitCost: '350',
    });
    expect(result.plan.lines).toEqual([
      {
        rowNumber: 2,
        product: { id: 100 },
        warehouse: { id: 1 },
        location: { id: 11 },
        lot: null,
        quantity: '10',
        unitCost: '350',
      },
    ]);
    expect(result.summary).toMatchObject({
      totalRows: 1,
      validRows: 1,
      errors: 0,
      stockRows: 1,
      create: { categories: 0, products: 0, warehouses: 0, lots: 0 },
      reuse: { categories: 1, products: 1, warehouses: 1, lots: 0 },
      warehouseIds: [1],
    });
  });

  it('plans new categories, products, warehouses and lots once', () => {
    const result = run([
      cells({
        sku: 'NEW-1',
        name: 'Taladro',
        category: 'Herramientas',
        warehouse: 'Bodega Este',
        warehouseCode: 'ESTE',
        warehouseType: 'Tienda',
        tracksLots: 'Lote',
        lotCode: 'L-9',
        expiryDate: '2028-01-01',
        description: 'Taladro 500W',
      }),
      cells({
        sku: 'new-1',
        name: 'Taladro',
        category: 'HERRAMIENTAS',
        warehouse: 'bodega este',
        tracksLots: 'Lote',
        lotCode: 'L-10',
      }),
    ]);
    expect(result.summary.errors).toBe(0);
    expect(result.plan.categories).toEqual([
      { key: 'category:herramientas', name: 'Herramientas' },
    ]);
    expect(result.plan.warehouses).toEqual([
      {
        key: 'warehouse:este',
        code: 'ESTE',
        name: 'Bodega Este',
        type: 'STORE',
        address: null,
      },
    ]);
    expect(result.plan.products).toEqual([
      expect.objectContaining({
        key: 'product:new-1',
        sku: 'NEW-1',
        category: { key: 'category:herramientas' },
        unitCode: 'EA',
        tracksLots: true,
        description: 'Taladro 500W',
      }),
    ]);
    expect(result.plan.lots.map((l) => [l.code, l.expiryDate])).toEqual([
      ['L-9', '2028-01-01'],
      ['L-10', null],
    ]);
    expect(result.plan.lines.map((l) => l.location)).toEqual([
      { key: 'location:warehouse:este' },
      { key: 'location:warehouse:este' },
    ]);
  });
});

describe('validateRows: cells and units', () => {
  it('requires the seven required values', () => {
    const result = run([{ sku: 'TOR-001' }]);
    expect(codesOf(result)).toEqual(Array(6).fill('REQUIRED_FIELD'));
    expect(result.rows[0].status).toBe('INVALID');
  });

  it('accepts unit aliases and refuses unknown units', () => {
    expect(run([cells({ stockUnit: 'Unidad' })]).summary.errors).toBe(0);
    expect(codesOf(run([cells({ stockUnit: 'cm' })]))).toEqual([
      'STOCK_UNIT_INVALID',
    ]);
  });

  it('warns once when there is no cost, and only where stock comes in', () => {
    expect(codesOf(run([cells({ unitCost: null })]))).toEqual(['COST_MISSING']);
    expect(
      codesOf(run([cells({ unitCost: null, stockQuantity: '0' })])),
    ).toEqual([]);
  });
});

describe('validateRows: existing products (INV-BR-02, INV-BR-03)', () => {
  it('refuses another unit, another tracking or an inactive product', () => {
    expect(codesOf(run([cells({ stockUnit: 'litro' })]))).toEqual([
      'UNIT_MISMATCH',
    ]);
    expect(
      codesOf(run([cells({ tracksLots: 'Lote', lotCode: 'L-1' })])),
    ).toEqual(['TRACKING_MISMATCH']);
    const inactive = lookups({
      products: new Map([['tor-001', { ...BOLT, isActive: false }]]),
    });
    expect(codesOf(run([cells()], inactive))).toEqual(['PRODUCT_INACTIVE']);
  });

  it("keeps Pango's descriptive values with one warning per product", () => {
    const result = run([
      cells({ name: 'Tornillo hex', category: 'Otra', lengthCm: '5' }),
      cells({ name: 'Tornillo hex', warehouse: 'Sur' }),
    ]);
    expect(result.issues.map((i) => [i.rowNumber, i.code, i.message])).toEqual([
      [
        2,
        'PRODUCT_DIFFERS',
        "name, category, lengthCm differ from Pango's; Pango's are kept",
      ],
    ]);
    expect(result.plan.products).toEqual([]);
  });
});

describe('validateRows: new products (INV-BR-18)', () => {
  const base = { sku: 'NEW-1', name: 'Taladro', category: 'Tornillería' };

  it('lets the first row define the product and warns once about later values', () => {
    const result = run([
      cells({ ...base, description: 'A' }),
      cells({ ...base, name: 'Taladro X', description: 'B', warehouse: 'Sur' }),
      cells({
        ...base,
        name: 'Taladro Y',
        warehouse: 'Norte',
        locationCode: 'A-01',
      }),
    ]);
    expect(result.issues.map((i) => [i.rowNumber, i.code])).toEqual([
      [3, 'PRODUCT_VALUES_DIFFER'],
    ]);
    expect(result.plan.products).toEqual([
      expect.objectContaining({ name: 'Taladro', description: 'A' }),
    ]);
    expect(result.plan.lines).toHaveLength(3);
  });

  it('refuses another unit or tracking for the same SKU', () => {
    const result = run([
      cells(base),
      cells({ ...base, stockUnit: 'litro', warehouse: 'Sur' }),
      cells({ ...base, tracksLots: 'Lote', lotCode: 'L', warehouse: 'Sur' }),
    ]);
    expect(codesOf(result, 3)).toEqual(['PRODUCT_INCONSISTENT']);
    expect(codesOf(result, 4)).toEqual(['PRODUCT_INCONSISTENT']);
  });

  it('resolves categories: one match, several, inactive or new (INV-BR-05)', () => {
    expect(codesOf(run([cells({ ...base, category: 'ACCESORIOS' })]))).toEqual([
      'CATEGORY_AMBIGUOUS',
    ]);
    expect(codesOf(run([cells({ ...base, category: 'Viejos' })]))).toEqual([
      'CATEGORY_INACTIVE',
    ]);
    // Accents matter, as in Pango: "Tornilleria" is another category.
    expect(
      run([cells({ ...base, category: 'Tornilleria' })]).plan.categories,
    ).toEqual([{ key: 'category:tornilleria', name: 'Tornilleria' }]);
  });
});

describe('validateRows: warehouses (INV-BR-04, INV-BR-06, INV-BR-15)', () => {
  it('needs code and name to point to the same warehouse', () => {
    expect(codesOf(run([cells({ warehouseCode: 'SUR' })]))).toEqual([
      'WAREHOUSE_CONFLICT',
    ]);
    expect(run([cells({ warehouseCode: 'norte' })]).summary.errors).toBe(0);
  });

  it('needs a code for a new warehouse, then accepts its name alone', () => {
    expect(codesOf(run([cells({ warehouse: 'Oeste' })]))).toEqual([
      'WAREHOUSE_CODE_REQUIRED',
    ]);
    const result = run([
      cells({ warehouse: 'Oeste', warehouseCode: 'OES' }),
      cells({
        sku: 'ACE-001',
        stockUnit: 'litro',
        tracksLots: 'Lote',
        lotCode: 'L-1',
        warehouse: 'oeste',
      }),
    ]);
    expect(result.summary.errors).toBe(0);
    expect(result.plan.warehouses).toHaveLength(1);
  });

  it('refuses warehouses outside the scope without revealing them', () => {
    const scoped = lookups({ scope: [1] });
    expect(codesOf(run([cells({ warehouse: 'Sur' })], scoped))).toEqual([
      'WAREHOUSE_FORBIDDEN',
    ]);
    // Code of a visible warehouse, name of a hidden one: still forbidden, not a conflict.
    expect(
      codesOf(
        run([cells({ warehouse: 'Sur', warehouseCode: 'NORTE' })], scoped),
      ),
    ).toEqual(['WAREHOUSE_FORBIDDEN']);
    expect(run([cells()], scoped).summary.errors).toBe(0);
  });

  it('refuses inactive warehouses and stock in warehouses that hold none', () => {
    const data = lookups({
      warehousesByName: new Map([
        ['norte', { ...NORTH, isActive: false }],
        ['sur', { ...SOUTH, holdsStock: false }],
      ]),
    });
    expect(codesOf(run([cells()], data))).toEqual(['WAREHOUSE_INACTIVE']);
    expect(codesOf(run([cells({ warehouse: 'Sur' })], data))).toEqual([
      'NON_STOCK_WAREHOUSE',
    ]);
    expect(
      codesOf(run([cells({ warehouse: 'Sur', stockQuantity: '0' })], data)),
    ).toEqual([]);
  });
});

describe('validateRows: locations (INV-BR-07)', () => {
  it("uses the product's default, then the warehouse's", () => {
    const withDefault = lookups({ productDefaults: new Map([['100:1', 12]]) });
    expect(run([cells()], withDefault).plan.lines[0].location).toEqual({
      id: 12,
    });
    expect(run([cells()]).plan.lines[0].location).toEqual({ id: 11 });
  });

  it('refuses unknown, inactive or non-default locations of a new warehouse', () => {
    expect(codesOf(run([cells({ locationCode: 'Z-9' })]))).toEqual([
      'LOCATION_INVALID',
    ]);
    expect(codesOf(run([cells({ locationCode: 'old' })]))).toEqual([
      'LOCATION_INVALID',
    ]);
    expect(
      codesOf(
        run([
          cells({
            warehouse: 'Oeste',
            warehouseCode: 'OES',
            locationCode: 'A-01',
          }),
        ]),
      ),
    ).toEqual(['LOCATION_INVALID']);
    expect(
      run([
        cells({
          warehouse: 'Oeste',
          warehouseCode: 'OES',
          locationCode: 'default',
        }),
      ]).summary.errors,
    ).toBe(0);
  });
});

describe('validateRows: lots (INV-BR-08, INV-BR-09)', () => {
  const oil = {
    sku: 'ACE-001',
    name: 'Aceite',
    category: 'Lubricantes',
    stockUnit: 'litro',
    tracksLots: 'Lote',
  };

  it('requires or refuses the lot code by tracking, and checks the dates', () => {
    expect(codesOf(run([cells(oil)]))).toEqual(['LOT_REQUIRED']);
    expect(codesOf(run([cells({ lotCode: 'L-1' })]))).toEqual([
      'LOT_NOT_ALLOWED',
    ]);
    expect(
      codesOf(
        run([
          cells({
            ...oil,
            lotCode: 'L-2',
            manufactureDate: '2026-05-01',
            expiryDate: '2026-04-01',
          }),
        ]),
      ),
    ).toEqual(['LOT_DATES_INVALID']);
  });

  it("reuses an existing lot and keeps Pango's dates", () => {
    const result = run([
      cells({ ...oil, lotCode: 'L-1', expiryDate: '2030-01-01' }),
    ]);
    expect(codesOf(result)).toEqual(['LOT_DATES_DIFFER']);
    expect(result.plan.lots).toEqual([]);
    expect(result.plan.lines[0].lot).toEqual({ id: 500 });
  });

  it('creates no lot for a zero quantity', () => {
    const result = run([cells({ ...oil, lotCode: 'L-7', stockQuantity: '0' })]);
    expect(result.plan.lots).toEqual([]);
    expect(result.plan.lines).toEqual([]);
    expect(result.rows[0].status).toBe('VALID');
  });
});

describe('validateRows: opening only and repeated rows', () => {
  it('refuses identities that already had stock or movements (INV-FR-05)', () => {
    const used = lookups({
      usedIdentities: new Set(['100:11:', '200:11:500']),
    });
    expect(codesOf(run([cells()], used))).toEqual(['ALREADY_HAS_STOCK']);
    const oil = {
      sku: 'ACE-001',
      name: 'Aceite',
      category: 'Lubricantes',
      stockUnit: 'litro',
      tracksLots: 'Lote',
    };
    expect(codesOf(run([cells({ ...oil, lotCode: 'L-1' })], used))).toEqual([
      'ALREADY_HAS_STOCK',
    ]);
    // A new lot of the same product is a new identity.
    expect(codesOf(run([cells({ ...oil, lotCode: 'L-NEW' })], used))).toEqual(
      [],
    );
    // Another location of the same warehouse too.
    expect(codesOf(run([cells({ locationCode: 'A-01' })], used))).toEqual([]);
  });

  it('counts identical rows once and refuses conflicting ones (INV-BR-12)', () => {
    const identical = run([cells(), cells({ stockQuantity: '10.0' })]);
    expect(identical.rows.map((r) => r.status)).toEqual(['VALID', 'DUPLICATE']);
    expect(codesOf(identical, 3)).toEqual(['DUPLICATE_ROW']);
    expect(identical.plan.lines).toHaveLength(1);
    expect(identical.summary.duplicateRows).toBe(1);

    const conflicting = run([cells(), cells({ stockQuantity: '11' })]);
    expect(conflicting.rows.map((r) => r.status)).toEqual([
      'INVALID',
      'INVALID',
    ]);
    expect(codesOf(conflicting, 2)).toEqual(['ROW_CONFLICT']);
    expect(codesOf(conflicting, 3)).toEqual(['ROW_CONFLICT']);
  });

  it('creates the entities of a zero row without stock (INV-BR-10)', () => {
    const result = run([
      cells({
        sku: 'NEW-0',
        name: 'Nuevo',
        category: 'Nueva',
        stockQuantity: '0',
      }),
    ]);
    expect(result.plan.products).toHaveLength(1);
    expect(result.plan.categories).toHaveLength(1);
    expect(result.plan.lines).toEqual([]);
    expect(result.summary.stockRows).toBe(0);
  });

  it('keeps quantities and costs exact', () => {
    const result = run([
      cells({ stockQuantity: '9999999999.9999', unitCost: '0.0001' }),
    ]);
    expect(result.issues.map((i) => i.code)).toEqual(['INVALID_VALUE']);
    const exact = run([
      cells({ stockQuantity: '1234567.8901', unitCost: '0.0001' }),
    ]);
    expect(exact.plan.lines[0]).toMatchObject({
      quantity: '1234567.8901',
      unitCost: '0.0001',
    });
    expect(new Prisma.Decimal(exact.plan.lines[0].quantity).toFixed(4)).toBe(
      '1234567.8901',
    );
  });
});
