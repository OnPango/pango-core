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
