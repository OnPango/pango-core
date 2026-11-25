// The canonical field dictionary of the inventory template (docs/modules/inventary.md,
// "Field dictionary"). Field metadata, mapping checks and row validation all read
// these definitions, so they cannot drift apart.

/** Version of the row format; a new incompatible format gets a new number. */
export const SCHEMA_VERSION = 1;

export type FieldType = 'text' | 'decimal' | 'date' | 'list' | 'unit';

export interface FieldDefinition {
  key: string;
  /** Header of the Spanish template, without its `*` / `**` markers. */
  label: string;
  required: boolean;
  type: FieldType;
  maxLength?: number;
  min?: number;
  max?: number;
  maxDecimals?: number;
  /** Accepted values of a list. */
  values?: string[];
  /** Required only when another field has this value. */
  requiredWhen?: Record<string, string>;
}

const QUANTITY = { min: 0, max: 9_999_999_999, maxDecimals: 4 } as const;
const DIMENSION = { min: 0, max: 99_999_999, maxDecimals: 2 } as const;

export const FIELDS = [
  {
    key: 'sku',
    label: 'Código producto',
    required: true,
    type: 'text',
    maxLength: 40,
  },
  {
    key: 'name',
    label: 'Producto',
    required: true,
    type: 'text',
    maxLength: 150,
  },
  {
    key: 'category',
    label: 'Categoría',
    required: true,
    type: 'text',
    maxLength: 80,
  },
  {
    key: 'stockUnit',
    label: 'Unidad de medida',
    required: true,
    type: 'unit',
    maxLength: 40,
  },
  {
    key: 'warehouse',
    label: 'Bodega',
    required: true,
    type: 'text',
    maxLength: 80,
  },
  {
    key: 'tracksLots',
    label: 'Seguimiento',
    required: true,
    type: 'list',
    values: ['Cantidad', 'Lote'],
  },
  {
    key: 'stockQuantity',
    label: 'Saldo inicial',
    required: true,
    type: 'decimal',
    ...QUANTITY,
  },
  {
    key: 'unitCost',
    label: 'Costo unitario',
    required: false,
    type: 'decimal',
    ...QUANTITY,
  },
  {
    key: 'lotCode',
    label: 'Código de lote',
    required: false,
    type: 'text',
    maxLength: 40,
    requiredWhen: { tracksLots: 'Lote' },
  },
  {
    key: 'locationCode',
    label: 'Ubicación',
    required: false,
    type: 'text',
    maxLength: 40,
  },
  {
    key: 'manufactureDate',
    label: 'Fecha fabricación',
    required: false,
    type: 'date',
  },
  {
    key: 'expiryDate',
    label: 'Fecha vencimiento',
    required: false,
    type: 'date',
  },
  {
    key: 'warehouseType',
    label: 'Tipo de almacén',
    required: false,
    type: 'list',
    values: ['Bodega', 'Tienda'],
  },
  {
    key: 'warehouseCode',
    label: 'Código de bodega',
    required: false,
    type: 'text',
    maxLength: 20,
  },
  {
    key: 'warehouseAddress',
    label: 'Dirección de bodega',
    required: false,
    type: 'text',
    maxLength: 200,
  },
  {
    key: 'description',
    label: 'Descripción',
    required: false,
    type: 'text',
    maxLength: 2000,
  },
  {
    key: 'lengthCm',
    label: 'Largo (cm)',
    required: false,
    type: 'decimal',
    ...DIMENSION,
  },
  {
    key: 'widthCm',
    label: 'Ancho (cm)',
    required: false,
    type: 'decimal',
    ...DIMENSION,
  },
  {
    key: 'heightCm',
    label: 'Alto (cm)',
    required: false,
    type: 'decimal',
    ...DIMENSION,
  },
  {
    key: 'weightKg',
    label: 'Peso (kg)',
    required: false,
    type: 'decimal',
    min: 0,
    max: 99_999_999,
    maxDecimals: 4,
  },
  {
    key: 'volumeL',
    label: 'Volumen (L)',
    required: false,
    type: 'decimal',
    ...QUANTITY,
  },
] as const satisfies readonly FieldDefinition[];

export type InventoryField = (typeof FIELDS)[number]['key'];

export const FIELD_KEYS: ReadonlySet<string> = new Set(
  FIELDS.map((f) => f.key),
);

export const REQUIRED_FIELDS: readonly InventoryField[] = FIELDS.filter(
  (f) => f.required,
).map((f) => f.key);

/**
 * Accepted ways of writing each unit of measure (INV-BR-11), besides its code.
 * Matched ignoring case and accents.
 */
export const UNIT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  EA: ['ud', 'und', 'unidad', 'unidades'],
  KGM: ['kg', 'kilo', 'kilogramo'],
  GRM: ['g', 'gr', 'gramo'],
  LTR: ['l', 'litro'],
  MLT: ['ml', 'mililitro'],
  MTR: ['m', 'metro'],
  BX: ['caja', 'cj'],
  PK: ['paquete', 'paq'],
};

/** Where a field comes from in the user's file. */
export interface SourceColumn {
  /** 1 = column A. */
  column: number;
  header: string;
}

export type ColumnMapping = Partial<
  Record<InventoryField, SourceColumn | null>
>;

const MAX_COLUMN = 16_384; // Excel's last column (XFD)
const MAX_HEADER = 200;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Checks the column mapping of a new import: only dictionary keys, each
 * `{ column, header }` or null; every required field mapped; a column feeds at
 * most one field. Returns the mapping to store, or the problems that reject it.
 */
export function checkMapping(input: unknown): {
  mapping: ColumnMapping;
  problems: string[];
} {
  const problems: string[] = [];
  const mapping: ColumnMapping = {};
  if (!isPlainObject(input)) {
    return { mapping, problems: ['mapping must be an object'] };
  }
  const columns = new Map<number, string>();
  for (const key of Object.keys(input)) {
    if (!FIELD_KEYS.has(key)) {
      problems.push(`mapping.${key} is not a field of the template`);
      continue;
    }
    const value = input[key];
    if (value === null) {
      mapping[key as InventoryField] = null;
      continue;
    }
    if (!isPlainObject(value)) {
      problems.push(`mapping.${key} must be { column, header } or null`);
      continue;
    }
    const extra = Object.keys(value).filter(
      (k) => k !== 'column' && k !== 'header',
    );
    const { column, header } = value;
    if (
      extra.length > 0 ||
      !Number.isInteger(column) ||
      (column as number) < 1 ||
      (column as number) > MAX_COLUMN ||
      typeof header !== 'string' ||
      header.length > MAX_HEADER
    ) {
      problems.push(
        `mapping.${key} must be { column: 1..${MAX_COLUMN}, header: text up to ${MAX_HEADER} } or null`,
      );
      continue;
    }
    const taken = columns.get(column as number);
    if (taken) {
      problems.push(
        `mapping.${key} uses column ${column}, already mapped to ${taken}`,
      );
      continue;
    }
    columns.set(column as number, key);
    mapping[key as InventoryField] = { column: column as number, header };
  }
  for (const key of REQUIRED_FIELDS) {
    if (
      !mapping[key] &&
      !problems.some((p) => p.startsWith(`mapping.${key} `))
    ) {
      problems.push(`mapping.${key} is required`);
    }
  }
  return { mapping, problems };
}
