import {
  cutoverOf,
  type ImportedClosing,
  importedLevelPoints,
} from './dashboard-imported-level.service.js';

const none = () => undefined;

const days = (...ends: string[]) => ends.map((end) => ({ start: end, end }));

describe('importedLevelPoints', () => {
  const closings: ImportedClosing[] = [
    { key: '1:10', day: '2026-09-01', closing: 50 },
    { key: '1:10', day: '2026-09-03', closing: 4 },
    { key: '2:10', day: '2026-09-02', closing: 0 },
    { key: '3:10', day: '2026-09-02', closing: 20 },
    { key: '3:11', day: '2026-09-01', closing: 30 },
  ];
  const reorderPoint = new Map([
    ['1:10', 5],
    ['3:10', 10],
  ]);

  it('counts the last closing on or before each period end, once per product', () => {
    const points = importedLevelPoints(
      days('2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'),
      closings,
      none,
      reorderPoint,
      true,
    );
    expect(points.map((p) => [p.inStock, p.lowStock])).toEqual([
      [0, 0], // nothing imported yet
      [2, 0], // product 1 (50) and product 3 (30 at warehouse 11)
      [2, 0], // product 2 closed at 0: no stock
      [1, 1], // product 1 fell to 4, at or below its reorder point 5
    ]);
  });

  it('stops counting a product-warehouse from its first Pango movement', () => {
    const points = importedLevelPoints(
      days('2026-09-02', '2026-09-03'),
      closings,
      (key) =>
        ({ '1:10': '2026-09-03', '3:11': '2026-09-03' })[key] as
          string | undefined,
      reorderPoint,
      true,
    );
    // On the 3rd product 1 and warehouse 11 belong to Pango; product 3 still has
    // stock at warehouse 10.
    expect(points.map((p) => p.inStock)).toEqual([2, 1]);
    expect(points[1].lowStock).toBe(0);
  });

  it('leaves low stock out without alert.read', () => {
    const [point] = importedLevelPoints(
      days('2026-09-03'),
      closings,
      none,
      reorderPoint,
      false,
    );
    expect(point).toEqual({
      start: '2026-09-03',
      end: '2026-09-03',
      inStock: 2,
      lowStock: null,
    });
  });

  it('does not treat a product without a reorder point as low', () => {
    const [point] = importedLevelPoints(
      days('2026-09-03'),
      [{ key: '9:10', day: '2026-09-01', closing: 1 }],
      none,
      new Map(),
      true,
    );
    expect(point.inStock).toBe(1);
    expect(point.lowStock).toBe(0);
  });
});

describe('cutoverOf', () => {
  const cutover = cutoverOf([
    { productId: 1, warehouseId: 10, day: '2026-11-25' },
    { productId: 2, warehouseId: 10, day: '2026-11-24' },
    { productId: 3, warehouseId: 11, day: '2026-11-26' },
  ]);

  it("is the product-warehouse's first Pango movement", () => {
    expect(cutover('1:10')).toBe('2026-11-25');
  });

  it('falls back to the first Pango movement of its warehouse', () => {
    expect(cutover('9:10')).toBe('2026-11-24');
    expect(cutover('9:11')).toBe('2026-11-26');
  });

  it('is none in a warehouse that never moved in Pango', () => {
    expect(cutover('9:12')).toBeUndefined();
  });
});
