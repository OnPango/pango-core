import { checkBatchRows } from './batch.js';
import { fingerprint } from './inventory-imports.service.js';

const row = (rowNumber: number, values: Record<string, unknown> = {}) => ({
  rowNumber,
  values: { sku: 'TOR-001', stockQuantity: '5', ...values },
});

describe('checkBatchRows', () => {
  it('keeps the rows as sent, text or null', () => {
    const { rows, problems } = checkBatchRows(
      [row(2), row(3, { unitCost: null, lotCode: '' })],
      2000,
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { rowNumber: 2, values: { sku: 'TOR-001', stockQuantity: '5' } },
      {
        rowNumber: 3,
        values: {
          sku: 'TOR-001',
          stockQuantity: '5',
          unitCost: null,
          lotCode: '',
        },
      },
    ]);
  });

  it('accepts bad cell contents: validation reports them later', () => {
    const { problems } = checkBatchRows(
      [row(2, { stockQuantity: 'abc', tracksLots: 'quizás' })],
      2000,
    );
    expect(problems).toEqual([]);
  });

  it('reports every structural problem with its position', () => {
    const prototypeKey = JSON.parse(
      '{"rowNumber": 9, "values": {"__proto__": "x"}}',
    ) as unknown;
    const { problems } = checkBatchRows(
      [
        'TOR-001',
        { rowNumber: 2, values: {}, extra: true },
        { rowNumber: 1, values: {} },
        { rowNumber: 2.5, values: {} },
        { rowNumber: 3, values: [] },
        row(4, { price: '10' }),
        row(5, { stockQuantity: 500 }),
        row(6, { name: 'x'.repeat(11) }),
        prototypeKey,
        row(10),
        row(10),
      ],
      10,
    );
    expect(problems).toEqual([
      'rows[0]: must be { rowNumber, values }',
      'rows[1]: unknown key extra',
      'rows[2]: rowNumber must be an integer from 2 (row 1 is the header)',
      'rows[3]: rowNumber must be an integer from 2 (row 1 is the header)',
      'rows[4]: values must be an object',
      'rows[5]: values.price is not a field of the template',
      'rows[6]: values.stockQuantity must be text or null',
      'rows[7]: values.name is longer than 10 characters',
      'rows[8]: values.__proto__ is not a field of the template',
      'rows[10]: rowNumber 10 is repeated',
    ]);
    expect(Object.prototype).not.toHaveProperty('x');
  });
});

describe('batch fingerprint', () => {
  it('is the same for the same rows in another order or key order', () => {
    const a = checkBatchRows([row(2), row(3)], 2000).rows;
    const b = checkBatchRows(
      [
        { rowNumber: 3, values: { stockQuantity: '5', sku: 'TOR-001' } },
        { rowNumber: 2, values: { stockQuantity: '5', sku: 'TOR-001' } },
      ],
      2000,
    ).rows;
    const sorted = (rows: typeof a) =>
      [...rows].sort((x, y) => x.rowNumber - y.rowNumber);
    expect(fingerprint(sorted(a))).toBe(fingerprint(sorted(b)));
    const changed = checkBatchRows(
      [row(2), row(3, { stockQuantity: '6' })],
      2000,
    ).rows;
    expect(fingerprint(sorted(changed))).not.toBe(fingerprint(sorted(a)));
  });
});
