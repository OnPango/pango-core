import { fold, parseDate, parseRow } from './parse.js';

const codes = (values: Record<string, string | null>) =>
  parseRow(2, values).issues.map((i) => [i.field, i.code]);

describe('parseRow', () => {
  it('types every present cell and leaves blank ones absent', () => {
    const { row, issues } = parseRow(7, {
      sku: '  0042 ',
      name: 'Tornillo',
      stockQuantity: '1250.5',
      unitCost: '0',
      tracksLots: 'LOTE',
      warehouseType: 'tienda',
      manufactureDate: '01/10/2026',
      expiryDate: '2027-04-30',
      lengthCm: '5.25',
      description: '   ',
      lotCode: null,
    });
    expect(issues).toEqual([]);
    expect(row).toMatchObject({
      rowNumber: 7,
      sku: '0042',
      name: 'Tornillo',
      tracksLots: true,
      warehouseType: 'STORE',
      manufactureDate: '2026-10-01',
      expiryDate: '2027-04-30',
    });
    expect(row.stockQuantity?.toString()).toBe('1250.5');
    expect(row.unitCost?.toString()).toBe('0');
    expect(row.lengthCm?.toString()).toBe('5.25');
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('lotCode');
  });

  it.each([
    ['1,250', 'thousands separator'],
    ['-1', 'negative'],
    ['12.34567', 'five decimals'],
    ['10000000000', 'above the maximum'],
    ['1e3', 'scientific notation'],
    ['abc', 'text'],
  ])('refuses %s as a quantity (%s)', (value) => {
    expect(codes({ stockQuantity: value })).toEqual([
      ['stockQuantity', 'INVALID_VALUE'],
    ]);
  });

  it('accepts the largest quantity and refuses three decimals in centimetres', () => {
    expect(
      codes({ stockQuantity: '9999999999', unitCost: '9999999999.0000' }),
    ).toEqual([]);
    expect(codes({ lengthCm: '1.234' })).toEqual([
      ['lengthCm', 'INVALID_VALUE'],
    ]);
  });

  it('refuses unknown list values and texts that are too long', () => {
    expect(
      codes({
        tracksLots: 'Serial',
        warehouseType: 'Oficina',
        sku: 'X'.repeat(41),
      }),
    ).toEqual([
      ['sku', 'INVALID_VALUE'],
      ['tracksLots', 'INVALID_VALUE'],
      ['warehouseType', 'INVALID_VALUE'],
    ]);
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-02-28', '2026-02-28'],
    ['28/02/2026', '2026-02-28'],
    ['2024-02-29', '2024-02-29'],
    ['2026-02-30', null],
    ['31/04/2026', null],
    ['2026-2-1', null],
    ['ayer', null],
  ])('reads %s as %s', (text, expected) => {
    expect(parseDate(text)).toBe(expected);
  });
});

describe('fold', () => {
  it('ignores case and accents', () => {
    expect(fold('CAJÁ')).toBe('caja');
    expect(fold('Lóte')).toBe('lote');
  });
});
