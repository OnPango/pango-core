import {
  checkMapping,
  FIELDS,
  REQUIRED_FIELDS,
  UNIT_ALIASES,
} from './fields.js';

const required = {
  sku: { column: 1, header: 'Código producto *' },
  name: { column: 2, header: 'Producto *' },
  category: { column: 3, header: 'Categoría *' },
  stockUnit: { column: 4, header: 'Unidad de medida *' },
  warehouse: { column: 5, header: 'Bodega *' },
  tracksLots: { column: 6, header: 'Seguimiento *' },
  stockQuantity: { column: 7, header: 'Saldo inicial *' },
};

describe('field dictionary', () => {
  it('has the 21 template columns, seven of them required', () => {
    expect(FIELDS).toHaveLength(21);
    expect(new Set(FIELDS.map((f) => f.key)).size).toBe(21);
    expect(REQUIRED_FIELDS).toEqual([
      'sku',
      'name',
      'category',
      'stockUnit',
      'warehouse',
      'tracksLots',
      'stockQuantity',
    ]);
  });

  it('never maps one alias to two units', () => {
    const all = Object.entries(UNIT_ALIASES).flatMap(([code, aliases]) => [
      code.toLowerCase(),
      ...aliases,
    ]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('checkMapping', () => {
  it('accepts the required fields with optional ones mapped or null', () => {
    const { mapping, problems } = checkMapping({
      ...required,
      unitCost: { column: 8, header: 'Costo unitario' },
      lotCode: null,
    });
    expect(problems).toEqual([]);
    expect(mapping).toEqual({
      ...required,
      unitCost: { column: 8, header: 'Costo unitario' },
      lotCode: null,
    });
  });

  it('reports every missing required field', () => {
    const { problems } = checkMapping({ sku: required.sku, name: null });
    expect(problems).toEqual([
      'mapping.name is required',
      'mapping.category is required',
      'mapping.stockUnit is required',
      'mapping.warehouse is required',
      'mapping.tracksLots is required',
      'mapping.stockQuantity is required',
    ]);
  });

  it('rejects unknown keys, prototype keys and malformed entries', () => {
    const input = JSON.parse(
      '{"__proto__": {"column": 9, "header": "x"}, "price": null}',
    ) as Record<string, unknown>;
    const { problems } = checkMapping({
      ...required,
      ...input,
      unitCost: { column: 0, header: 'Costo' },
      description: { column: 10, header: 'Descripción', extra: true },
      volumeL: 'U',
    });
    expect(problems).toEqual([
      'mapping.__proto__ is not a field of the template',
      'mapping.price is not a field of the template',
      'mapping.unitCost must be { column: 1..16384, header: text up to 200 } or null',
      'mapping.description must be { column: 1..16384, header: text up to 200 } or null',
      'mapping.volumeL must be { column, header } or null',
    ]);
    expect(Object.prototype).not.toHaveProperty('column');
  });

  it('lets a column feed only one field', () => {
    const { problems } = checkMapping({
      ...required,
      description: { column: 2, header: 'Producto *' },
    });
    expect(problems).toEqual([
      'mapping.description uses column 2, already mapped to name',
    ]);
  });

  it('rejects a mapping that is not an object', () => {
    expect(checkMapping(['sku']).problems).toEqual([
      'mapping must be an object',
    ]);
    expect(checkMapping(null).problems).toEqual(['mapping must be an object']);
  });
});
