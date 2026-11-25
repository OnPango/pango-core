import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryImportStatus } from '../generated/prisma/tenant/enums.js';

export class InventoryImportUserDto {
  @ApiProperty({ example: 4 })
  id: number;

  @ApiProperty({ type: String, nullable: true, example: 'Ana Pérez' })
  name: string | null;
}

export class InventoryImportDto {
  @ApiProperty({ example: 15 })
  id: number;

  @ApiProperty({
    enum: InventoryImportStatus,
    enumName: 'InventoryImportStatus',
    example: 'RECEIVING',
  })
  status: InventoryImportStatus;

  @ApiProperty({ example: 1 })
  schemaVersion: number;

  @ApiProperty({ example: 'inventario-noviembre.xlsx' })
  fileName: string;

  @ApiProperty({ example: 'Inventario' })
  sheetName: string;

  @ApiProperty({ example: 4800 })
  totalRows: number;

  @ApiProperty({ example: 0 })
  receivedRows: number;

  @ApiProperty({ example: 0, description: 'Bumped by every validation' })
  revision: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Counts of the last validation; null before it',
  })
  summary: Record<string, unknown> | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'What the confirmation created; null before it',
  })
  result: Record<string, unknown> | null;

  @ApiProperty({ type: InventoryImportUserDto })
  createdBy: InventoryImportUserDto;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'When an open import expires without activity; null once closed',
  })
  expiresAt: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  confirmedAt: Date | null;
}

export class InventoryImportPageDto {
  @ApiProperty({ type: [InventoryImportDto] })
  items: InventoryImportDto[];

  @ApiProperty({ example: 3 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class InventoryImportLimitsDto {
  @ApiProperty({ example: 5000 })
  maxRowsPerBatch: number;

  @ApiProperty({ example: 5000 })
  maxRowsPerImport: number;

  @ApiProperty({
    example: 1048576,
    description: 'Serialized UTF-8 size of a whole request body',
  })
  maxRequestBytes: number;

  @ApiProperty({ example: 2000, description: 'Characters of one value' })
  maxValueChars: number;

  @ApiProperty({
    example: 4096,
    description: 'Characters of all the values of one row',
  })
  maxRowChars: number;

  @ApiProperty({
    example: 24,
    description: 'Hours without activity before an open import expires',
  })
  expiryHours: number;
}

export class InventoryImportFieldDto {
  @ApiProperty({ example: 'sku' })
  key: string;

  @ApiProperty({
    example: 'Código producto',
    description: "The template's header, without markers",
  })
  label: string;

  @ApiProperty({ example: true })
  required: boolean;

  @ApiProperty({
    enum: ['text', 'decimal', 'date', 'list', 'unit'],
    example: 'text',
  })
  type: string;

  @ApiPropertyOptional({ example: 40 })
  maxLength?: number;

  @ApiPropertyOptional({ example: 0 })
  min?: number;

  @ApiPropertyOptional({ example: 9999999999 })
  max?: number;

  @ApiPropertyOptional({ example: 4 })
  maxDecimals?: number;

  @ApiPropertyOptional({ type: [String], example: ['Cantidad', 'Lote'] })
  values?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { tracksLots: 'Lote' },
  })
  requiredWhen?: Record<string, string>;
}

export class InventoryImportUnitDto {
  @ApiProperty({ example: 'EA' })
  code: string;

  @ApiProperty({ example: 'Each' })
  name: string;

  @ApiProperty({ type: [String], example: ['ud', 'und', 'unidad', 'unidades'] })
  aliases: string[];
}

export class InventoryImportFieldsDto {
  @ApiProperty({ example: 1 })
  schemaVersion: number;

  @ApiProperty({ type: InventoryImportLimitsDto })
  limits: InventoryImportLimitsDto;

  @ApiProperty({ type: [InventoryImportFieldDto] })
  fields: InventoryImportFieldDto[];

  @ApiProperty({
    type: [InventoryImportUnitDto],
    description:
      'Units of measure of the organization and the accepted ways of writing each',
  })
  units: InventoryImportUnitDto[];
}

export class AppendInventoryRowsResultDto {
  @ApiProperty({ example: 15 })
  importId: number;

  @ApiProperty({ example: 1 })
  batchNumber: number;

  @ApiProperty({ example: 1800, description: 'Rows of this batch' })
  acceptedRows: number;

  @ApiProperty({
    example: 1800,
    description: 'Rows the import holds after this batch',
  })
  receivedRows: number;

  @ApiProperty({ example: 4800 })
  totalRows: number;

  @ApiProperty({
    enum: InventoryImportStatus,
    enumName: 'InventoryImportStatus',
    example: 'RECEIVING',
  })
  status: InventoryImportStatus;

  @ApiProperty({
    example: false,
    description:
      'True when this batch had already been received: nothing changed',
  })
  replayed: boolean;
}

export class InventoryImportSourceColumnDto {
  @ApiProperty({ example: 8, description: '1 = column A' })
  column: number;

  @ApiProperty({ example: 'Costo unitario' })
  header: string;
}

export class InventoryImportIssueDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 245,
    description: 'Row of the file; null for an issue of the whole import',
  })
  rowNumber: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'unitCost' })
  field: string | null;

  @ApiProperty({
    type: InventoryImportSourceColumnDto,
    nullable: true,
    description: 'Where the field comes from in the file, from the mapping',
  })
  sourceColumn: InventoryImportSourceColumnDto | null;

  @ApiProperty({ enum: ['ERROR', 'WARNING'], example: 'WARNING' })
  severity: 'ERROR' | 'WARNING';

  @ApiProperty({ example: 'COST_MISSING' })
  code: string;

  @ApiProperty({
    example: "No unit cost: the stock takes the product's current average cost",
  })
  message: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The offending value, truncated to 200 characters',
  })
  value: string | null;
}

export class InventoryImportIssuePageDto {
  @ApiProperty({
    example: 1,
    description:
      'Revision of the validation these issues come from (0 before any)',
  })
  revision: number;

  @ApiProperty({ type: [InventoryImportIssueDto] })
  items: InventoryImportIssueDto[];

  @ApiProperty({ example: 37 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}

export class InventoryImportReportDto {
  @ApiProperty({ type: InventoryImportDto })
  import: InventoryImportDto;

  @ApiProperty({
    type: InventoryImportIssuePageDto,
    description: 'The first page of issues, by row',
  })
  issues: InventoryImportIssuePageDto;
}

export class PreviewEntityDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 31,
    description: 'Null when the confirmation would create it',
  })
  id: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'Tornillo' })
  name: string | null;

  @ApiProperty({ example: false })
  isNew: boolean;
}

export class PreviewWarehouseDto extends PreviewEntityDto {
  @ApiProperty({ type: String, nullable: true, example: 'PRINCIPAL' })
  code: string | null;
}

export class PreviewLotDto {
  @ApiProperty({ type: Number, nullable: true, example: null })
  id: number | null;

  @ApiProperty({ example: 'L-2026-11' })
  code: string;

  @ApiProperty({ example: true })
  isNew: boolean;
}

export class InventoryImportRowPreviewDto {
  @ApiProperty({ example: 2 })
  rowNumber: number;

  @ApiProperty({
    enum: ['PENDING', 'VALID', 'INVALID', 'DUPLICATE'],
    example: 'VALID',
  })
  status: 'PENDING' | 'VALID' | 'INVALID' | 'DUPLICATE';

  @ApiProperty({ type: String, nullable: true, example: 'TOR-001' })
  sku: string | null;

  @ApiProperty({ type: PreviewEntityDto, nullable: true })
  product: PreviewEntityDto | null;

  @ApiProperty({ type: PreviewEntityDto, nullable: true })
  category: PreviewEntityDto | null;

  @ApiProperty({ type: PreviewWarehouseDto, nullable: true })
  warehouse: PreviewWarehouseDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'DEFAULT' })
  locationCode: string | null;

  @ApiProperty({ type: PreviewLotDto, nullable: true })
  lot: PreviewLotDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'EA' })
  stockUnit: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '500',
    description: 'Exact digits, as text',
  })
  quantity: string | null;

  @ApiProperty({ type: String, nullable: true, example: '350' })
  unitCost: string | null;

  @ApiProperty({ example: 0, description: 'Errors and warnings of the row' })
  issues: number;
}

export class InventoryImportRowPageDto {
  @ApiProperty({
    example: 1,
    description:
      'Revision of the validation this preview comes from (0 before any)',
  })
  revision: number;

  @ApiProperty({ type: [InventoryImportRowPreviewDto] })
  items: InventoryImportRowPreviewDto[];

  @ApiProperty({ example: 4800 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 25 })
  pageSize: number;
}
