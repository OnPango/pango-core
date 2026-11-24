import { ApiProperty } from '@nestjs/swagger';

export class MovementImportDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'siigo-main' })
  sourceNamespace: string;

  @ApiProperty({ example: 'kardex-2025.xlsx', nullable: true, type: String })
  fileName: string | null;

  @ApiProperty({
    enum: ['RECEIVING', 'VALIDATED', 'CONFIRMED'],
    enumName: 'MovementImportStatus',
  })
  status: 'RECEIVING' | 'VALIDATED' | 'CONFIRMED';

  @ApiProperty({
    example: 1,
    description: 'Bumped by every validation; confirm the one you reviewed',
  })
  revision: number;

  @ApiProperty({ example: 4, description: 'Rows received' })
  rowCount: number;

  @ApiProperty({
    example: 4,
    description: 'Rows without errors (last validation)',
  })
  validRowCount: number;

  @ApiProperty({ example: 0, description: 'Rows with at least one error' })
  invalidRowCount: number;

  @ApiProperty({
    example: 0,
    description:
      'Repeats of an earlier row, or lines already in the history: counted once',
  })
  duplicateRowCount: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: { UNKNOWN_SKU: 2 },
    description:
      'Every issue of the last validation, by code (the list keeps the first 10,000)',
  })
  issueCounts: Record<string, number>;

  @ApiProperty({
    example: 3,
    description: 'Tenant user who started the import',
  })
  uploadedById: number;

  @ApiProperty({ nullable: true, type: Date })
  confirmedAt: Date | null;

  @ApiProperty({
    example: 4,
    nullable: true,
    type: Number,
    description: 'Lines saved into the history by the confirmation',
  })
  savedCount: number | null;

  @ApiProperty({
    example: 0,
    nullable: true,
    type: Number,
    description: 'Valid lines another import had already saved',
  })
  skippedCount: number | null;

  @ApiProperty()
  createdAt: Date;
}

export class AppendRowsResultDto {
  @ApiProperty({ example: 2000, description: 'Rows of this request' })
  received: number;

  @ApiProperty({ type: MovementImportDto })
  import: MovementImportDto;
}

export class ImportIssueDto {
  @ApiProperty({
    example: 3,
    nullable: true,
    type: Number,
    description: "Row of the user's file (the header is row 1)",
  })
  rowNumber: number | null;

  @ApiProperty({ example: 'sku', nullable: true, type: String })
  field: string | null;

  @ApiProperty({ enum: ['ERROR', 'WARNING'], enumName: 'ImportIssueSeverity' })
  severity: 'ERROR' | 'WARNING';

  @ApiProperty({
    example: 'UNKNOWN_SKU',
    description:
      'Errors: REQUIRED, FIELD_TOO_LONG, INVALID_DATE, DATE_IN_FUTURE, INVALID_NUMBER, ' +
      'INVALID_QUANTITY, QUANTITY_SIDE, UNKNOWN_MOVEMENT_TYPE, MOVEMENT_TYPE_NOT_ALLOWED, ' +
      'UNKNOWN_WAREHOUSE, UNKNOWN_SKU, UNIT_MISMATCH, UNKNOWN_LOCATION, LOT_REQUIRED, ' +
      'LOT_NOT_ALLOWED, KEY_CONFLICT, IMPORTED_DIFFERENTLY, DOCUMENT_INCONSISTENT, ' +
      'BALANCE_MISMATCH. Warnings: LOT_NOT_FOUND, DUPLICATE_ROW, ALREADY_IMPORTED, NO_BALANCE',
  })
  code: string;

  @ApiProperty({ example: 'No product with this SKU' })
  message: string;

  @ApiProperty({ example: 'SKU-404', nullable: true, type: String })
  value: string | null;
}

export class ImportIssuePageDto {
  @ApiProperty({ type: [ImportIssueDto] })
  items: ImportIssueDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class MovementImportReportDto {
  @ApiProperty({ type: MovementImportDto })
  import: MovementImportDto;

  @ApiProperty({ type: ImportIssuePageDto })
  issues: ImportIssuePageDto;
}

class ProductRefDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'SKU-001' })
  sku: string;

  @ApiProperty({ example: 'Hex bolt' })
  name: string;

  @ApiProperty({ example: 'EA' })
  unit: string;
}

class WarehouseRefDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'MAIN' })
  code: string;

  @ApiProperty({ example: 'Main warehouse' })
  name: string;
}

export class ImportBalanceDto {
  @ApiProperty({ type: ProductRefDto })
  product: ProductRefDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 4, description: 'Valid rows of the pair' })
  rows: number;

  @ApiProperty({
    example: 105,
    nullable: true,
    type: Number,
    description:
      'Closing balance the file gives after its last valid row; null when it ' +
      'sets no starting balance (no opening and no balance_after)',
  })
  closing: number | null;

  @ApiProperty({
    example: 15,
    description:
      'Outbound quantity of types that count as demand (sales, consumption)',
  })
  demand: number;
}

export class ImportBalancePageDto {
  @ApiProperty({ type: [ImportBalanceDto] })
  items: ImportBalanceDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

class HistoricalSourceDto {
  @ApiProperty({ example: 3 })
  importId: number;

  @ApiProperty({ example: 'siigo-main' })
  sourceNamespace: string;

  @ApiProperty({ example: 'SALE-001' })
  externalMovementId: string;

  @ApiProperty({ example: 1 })
  lineNumber: number;
}

export class HistoricalMovementDto {
  @ApiProperty({ example: 12 })
  id: number;

  @ApiProperty({
    example: '2025-08-04',
    description: 'Business date of the source',
  })
  date: string;

  @ApiProperty({
    example: 'SALE',
    enum: [
      'OPENING_BALANCE',
      'PURCHASE_RECEIPT',
      'SALE',
      'INTERNAL_CONSUMPTION',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'TRANSFER_OUT',
      'TRANSFER_IN',
    ],
  })
  movementType: string;

  @ApiProperty({ type: ProductRefDto })
  product: ProductRefDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: null, nullable: true, type: Number })
  quantityIn: number | null;

  @ApiProperty({ example: 12, nullable: true, type: Number })
  quantityOut: number | null;

  @ApiProperty({
    example: 108,
    nullable: true,
    type: Number,
    description: 'Balance after this line, from the source file',
  })
  balance: number | null;

  @ApiProperty({ example: 'INV-100', nullable: true, type: String })
  documentRef: string | null;

  @ApiProperty({ example: 'DEFAULT', nullable: true, type: String })
  locationCode: string | null;

  @ApiProperty({ example: null, nullable: true, type: String })
  lotCode: string | null;

  @ApiProperty({ example: null, nullable: true, type: Number })
  unitCost: number | null;

  @ApiProperty({
    example: false,
    description:
      'On or after the first movement registered in Pango for this product in this ' +
      'warehouse: shown, but not counted in demand or the forecast (Pango rules from then on)',
  })
  afterCutover: boolean;

  @ApiProperty({ type: HistoricalSourceDto })
  source: HistoricalSourceDto;
}

export class HistoricalMovementPageDto {
  @ApiProperty({ type: [HistoricalMovementDto] })
  items: HistoricalMovementDto[];

  @ApiProperty({ example: 1 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
