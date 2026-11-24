import { readFileSync } from 'node:fs';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { type IncomingRow, V1_COLUMNS } from './import-format.js';
import { normalize, parseDecimal, textDate } from './normalize.js';
import { historyFingerprint, type Lookups, validate } from './validate.js';

const TEMPLATE = readFileSync(
  new URL(
    '../../docs/templates/pango-standard-kardex-movement-history-import-v1.csv',
    import.meta.url,
  ),
  'utf8',
);
const HEADER = TEMPLATE.split('\n')[0].trim();

/** Rows as the frontend sends them, from simple CSV text (no quoted commas). */
function rowsFrom(csv: string): IncomingRow[] {
  const [header, ...lines] = csv.trim().split('\n');
  const columns = header.trim().split(',');
  return lines.map((line, index) => {
    const cells = line.trim().split(',');
    const values = Object.fromEntries(
      V1_COLUMNS.map((c) => [c, cells[columns.indexOf(c)] || null]),
    ) as IncomingRow['values'];
    return { rowNumber: index + 2, values };
  });
}

const lookups = (overrides: Partial<Lookups> = {}): Lookups => ({
  warehouses: new Map([['main', { id: 1, code: 'MAIN' }]]),
  products: new Map([
    ['sku-001', { id: 10, sku: 'SKU-001', tracksLots: false, unitCode: 'EA' }],
    ['lot-1', { id: 11, sku: 'LOT-1', tracksLots: true, unitCode: 'KG' }],
  ]),
  locations: new Map([['1:default', 100]]),
  lots: new Map([['11:l-1', 500]]),
  types: new Map([
    ['Opening balance', { id: 1, countsAsDemand: false }],
    ['Purchase receipt', { id: 2, countsAsDemand: false }],
    ['Consumption issue', { id: 3, countsAsDemand: true }],
    ['Transfer', { id: 4, countsAsDemand: false }],
    ['Inventory adjustment', { id: 5, countsAsDemand: false }],
    ['Sales issue', { id: 6, countsAsDemand: true }],
  ]),
  allowedTypes: new Map([[1, new Set([1, 2, 3, 4, 5, 6])]]),
  ...overrides,
});

const run = (
  csv: string,
  options: {
    lookups?: Lookups;
    today?: string;
    existing?: Map<string, string>;
  } = {},
) => {
  const parsed = normalize(rowsFrom(csv));
  return validate(parsed.rows, parsed.issues, options.lookups ?? lookups(), {
    today: options.today ?? '2026-11-24',
    existing: options.existing ?? new Map(),
  });
};

const codes = (result: ReturnType<typeof run>) =>
  result.issues.map((i) => `${i.rowNumber}:${i.field}:${i.code}`);
const errorsOnly = (result: ReturnType<typeof run>) =>
  codes(result).filter((c) => !c.endsWith('NO_BALANCE'));

describe('dates and numbers', () => {
  it('reads ISO and day-first dates, rejecting impossible ones', () => {
    expect(textDate('2026-08-04')).toBe('2026-08-04');
    expect(textDate('4/8/2026')).toBe('2026-08-04');
    expect(textDate('31/02/2026')).toBeNull();
    expect(textDate('08/04/26')).toBeNull();
  });

  it('parses decimals with a point only, without grouping or more than 4 decimals', () => {
    expect(parseDecimal('12.5')?.toString()).toBe('12.5');
    expect(parseDecimal('-3')?.toString()).toBe('-3');
    expect(parseDecimal('12,5')).toBeNull();
    expect(parseDecimal('1,234')).toBeNull();
    expect(parseDecimal('0.12345')).toBeNull();
    expect(parseDecimal('1e3')).toBeNull();
  });
});

describe('validate', () => {
  it('previews the template: 4 valid rows, closing 105 and demand 15', () => {
    const result = run(TEMPLATE);
    expect(result.issues).toEqual([]);
    expect(result.rows.map((r) => r.status)).toEqual([
      'VALID',
      'VALID',
      'VALID',
      'VALID',
    ]);
    expect(result.rows.at(-1)?.runningBalance?.toString()).toBe('105');
    const demand = result.rows.reduce(
      (sum, r) => sum + r.demandQuantity.toNumber(),
      0,
    );
    expect(demand).toBe(15);
    expect(result.rows[0]).toMatchObject({
      warehouseId: 1,
      productId: 10,
      locationId: 100,
      movementTypeId: 1,
      leg: 'LINE',
    });
  });

  it('reports unknown references by row and field, with the leading-zero hint', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,NORTH,SKU-001,EA,SALE,,1,,,DEFAULT,,\nB,1,2026-08-04,MAIN,00123,EA,SALE,,1,,,DEFAULT,,\nC,1,2026-08-04,MAIN,SKU-001,EA,SALE,,1,,,SHELF-9,,\n`,
    );
    expect(codes(result)).toEqual([
      '2:warehouse_code:UNKNOWN_WAREHOUSE',
      '3:sku:UNKNOWN_SKU',
      '4:location_code:UNKNOWN_LOCATION',
    ]);
    expect(result.issues[1].message).toMatch(/leading zeros/);
    expect(result.issues[1].value).toBe('00123');
    expect(result.rows.every((r) => r.status === 'INVALID')).toBe(true);
  });

  it('resolves a blank unit from the SKU and reports a different one', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,ea,SALE,,1,,,,,\nC,1,2026-08-04,MAIN,SKU-001,KG,SALE,,1,,,,,\n`,
    );
    expect(errorsOnly(result)).toEqual(['4:stock_unit:UNIT_MISMATCH']);
    expect(result.rows[0].locationId).toBe(100);
  });

  it('checks dates, sides and quantities', () => {
    const result = run(
      `${HEADER}\nA,1,2026-12-01,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,3,,,,,,\nC,1,2026-08-04,MAIN,SKU-001,,SALE,,0,,,,,\nD,1,2026-08-04,MAIN,SKU-001,,OPENING_BALANCE,0,,0,,,,\nE,1,2026-08-04,MAIN,SKU-001,,RETURN,,1,,,,,\nF,x,32/01/2026,,SKU-001,,SALE,,-1,,,,,\n`,
    );
    expect(codes(result)).toEqual([
      '2:business_date:DATE_IN_FUTURE',
      '3:quantity_in:QUANTITY_SIDE',
      '4:quantity_out:INVALID_QUANTITY',
      '6:movement_type:UNKNOWN_MOVEMENT_TYPE',
      '7:line_number:INVALID_NUMBER',
      '7:business_date:INVALID_DATE',
      '7:warehouse_code:REQUIRED',
      '7:quantity_out:INVALID_NUMBER',
    ]);
    // A documented zero opening is valid source evidence.
    expect(result.rows[3].status).toBe('VALID');
  });

  it('applies lot rules; a lot unknown to Pango is only a warning', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,LOT-1,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,L-1,\nC,1,2026-08-04,MAIN,LOT-1,,SALE,,1,,,,l-1,\nD,1,2026-08-04,MAIN,LOT-1,,SALE,,1,,,,L-NEW,\n`,
    );
    expect(errorsOnly(result)).toEqual([
      '2:lot_code:LOT_REQUIRED',
      '3:lot_code:LOT_NOT_ALLOWED',
      '5:lot_code:LOT_NOT_FOUND',
    ]);
    expect(result.rows[2]).toMatchObject({ status: 'VALID', lotId: 500 });
    expect(result.rows[3].status).toBe('VALID');
  });

  it('counts an exact repeat once and blocks a changed copy', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,INV-1,,,\nA,1,2026-08-04,MAIN,sku-001,,SALE,,1.0,,INV-1,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,,2,,,,,\n`,
    );
    expect(result.rows.map((r) => r.status)).toEqual([
      'VALID',
      'DUPLICATE',
      'INVALID',
      'INVALID',
    ]);
    expect(errorsOnly(result)).toEqual([
      '3:null:DUPLICATE_ROW',
      '4:external_movement_id:KEY_CONFLICT',
      '5:external_movement_id:KEY_CONFLICT',
    ]);
  });

  it('skips lines already imported and blocks ones imported differently', () => {
    const saved = (quantityOut: string) =>
      historyFingerprint({
        businessDate: '2026-08-04',
        warehouseId: 1,
        productId: 10,
        movementCode: 'SALE',
        quantityIn: null,
        quantityOut: new Prisma.Decimal(quantityOut),
        locationCode: 'default',
        lotCode: null,
        unitCost: null,
      });
    const result = run(
      `${HEADER}\nO,1,2026-08-01,MAIN,SKU-001,,OPENING_BALANCE,10,,10,,,,\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,,2,,,,,\nC,1,2026-08-05,MAIN,SKU-001,,SALE,,3,6,,,,\n`,
      {
        existing: new Map([
          ['A\u00001\u0000LINE', saved('1.0000')],
          ['B\u00001\u0000LINE', saved('5')],
        ]),
      },
    );
    expect(codes(result)).toEqual([
      '3:null:ALREADY_IMPORTED',
      '4:external_movement_id:IMPORTED_DIFFERENTLY',
    ]);
    expect(result.rows.map((r) => r.status)).toEqual([
      'VALID',
      'DUPLICATE',
      'INVALID',
      'VALID',
    ]);
    // B's error breaks the chain; C restarts it at its reported 6.
    expect(result.rows[3].runningBalance?.toString()).toBe('6');
  });

  it('keeps an already imported line in the balance chain', () => {
    const existing = new Map([
      [
        'A\u00001\u0000LINE',
        historyFingerprint({
          businessDate: '2026-08-04',
          warehouseId: 1,
          productId: 10,
          movementCode: 'SALE',
          quantityIn: null,
          quantityOut: new Prisma.Decimal(1),
          locationCode: null,
          lotCode: null,
          unitCost: null,
        }),
      ],
    ]);
    const result = run(
      `${HEADER}\nO,1,2026-08-01,MAIN,SKU-001,,OPENING_BALANCE,10,,10,,,,\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nC,1,2026-08-05,MAIN,SKU-001,,SALE,,3,6,,,,\n`,
      { existing },
    );
    expect(codes(result)).toEqual(['3:null:ALREADY_IMPORTED']);
    expect(result.rows[2]).toMatchObject({ status: 'VALID' });
    expect(result.rows[2].runningBalance?.toString()).toBe('6');
  });

  it('keeps two genuine sales of the same SKU and day apart by their keys', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\n`,
    );
    expect(result.rows.map((r) => r.status)).toEqual(['VALID', 'VALID']);
  });

  it('requires the lines of one movement to agree', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,INV-1,,,\nA,2,2026-08-05,MAIN,SKU-001,,SALE,,1,,INV-1,,,\nT,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nT,1,2026-08-04,MAIN,SKU-001,,TRANSFER_OUT,,1,,,,,\n`,
    );
    expect(errorsOnly(result)).toEqual([
      '2:business_date:DOCUMENT_INCONSISTENT',
      '3:business_date:DOCUMENT_INCONSISTENT',
      '4:movement_type:DOCUMENT_INCONSISTENT',
      '5:movement_type:DOCUMENT_INCONSISTENT',
    ]);
  });

  it('checks reported balances in event order and restarts after a mismatch', () => {
    const result = run(
      `${HEADER}\nB,1,2026-08-05,MAIN,SKU-001,,SALE,,5,96,,,,\nA,1,2026-08-04,MAIN,SKU-001,,ADJUSTMENT_IN,,,,,,,\nO,1,2026-08-01,MAIN,SKU-001,,OPENING_BALANCE,100,,100,,,,\nC,1,2026-08-06,MAIN,SKU-001,,SALE,,6,90,,,,\n`,
    );
    // Row 3 lacks its quantity, which breaks the chain: B restarts it at 96.
    expect(codes(result)).toEqual(['3:quantity_in:REQUIRED']);
    expect(result.rows[3].runningBalance?.toString()).toBe('90');

    const mismatch = run(
      `${HEADER}\nO,1,2026-08-01,MAIN,SKU-001,,OPENING_BALANCE,100,,100,,,,\nB,1,2026-08-05,MAIN,SKU-001,,SALE,,5,96,,,,\nC,1,2026-08-06,MAIN,SKU-001,,SALE,,6,90,,,,\n`,
    );
    expect(codes(mismatch)).toEqual(['3:balance_after:BALANCE_MISMATCH']);
    expect(mismatch.rows[2].runningBalance?.toString()).toBe('90');
  });

  it('warns once per product and warehouse that never sets a balance', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,,,,,\nB,1,2026-08-05,MAIN,SKU-001,,SALE,,2,,,,,\n`,
    );
    expect(codes(result)).toEqual(['2:null:NO_BALANCE']);
    expect(result.rows.every((r) => r.status === 'VALID')).toBe(true);
  });

  it('only accepts warehouses and types the user may import', () => {
    const one = `${HEADER}\nA,1,2026-08-04,MAIN,SKU-001,,SALE,,1,1,,,,\n`;
    const result = run(one, {
      lookups: lookups({ allowedTypes: new Map([[1, new Set([1])]]) }),
    });
    expect(codes(result)).toEqual([
      '2:movement_type:MOVEMENT_TYPE_NOT_ALLOWED',
    ]);
    const hidden = run(one, { lookups: lookups({ warehouses: new Map() }) });
    expect(codes(hidden)).toEqual(['2:warehouse_code:UNKNOWN_WAREHOUSE']);
  });

  it('reports over-long values without reading them', () => {
    const result = run(
      `${HEADER}\nA,1,2026-08-04,MAIN,${'S'.repeat(41)},,SALE,,1,,,,,\n`,
    );
    expect(codes(result)).toEqual(['2:sku:FIELD_TOO_LONG']);
  });
});
