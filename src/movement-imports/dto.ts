import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../forecasting/dto.js';
import { IMPORT_LIMITS, V1_COLUMNS } from './import-format.js';

export class CreateMovementImportDto {
  @ApiProperty({
    example: 'siigo-main',
    description:
      'The source system the external movement ids belong to. Keep it the same ' +
      'across imports from that system: letters, digits, `.`, `_`, `-`, up to 60',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/)
  sourceNamespace: string;

  @ApiPropertyOptional({
    example: 'kardex-2025.xlsx',
    description: "Name of the user's file, for display only",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/** Documentation of one sent row (the service checks the shape itself). */
class ImportRowDto {
  @ApiProperty({
    example: 2,
    description: "Row of the user's file, the header being row 1",
  })
  rowNumber: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description:
      `The template columns (${V1_COLUMNS.join(', ')}), each a string or null. ` +
      'Dates as YYYY-MM-DD, decimals with "." and no thousands separators',
    example: {
      external_movement_id: 'SALE-001',
      line_number: '1',
      business_date: '2025-08-04',
      warehouse_code: 'MAIN',
      sku: 'SKU-001',
      stock_unit: null,
      movement_type: 'SALE',
      quantity_in: null,
      quantity_out: '12',
      balance_after: '108',
      document_ref: 'INV-100',
      location_code: null,
      lot_code: null,
      unit_cost: null,
    },
  })
  values: Record<string, string | null>;
}

export class AppendImportRowsDto {
  @ApiProperty({
    type: [ImportRowDto],
    description: `1 to ${IMPORT_LIMITS.maxRowsPerBatch} rows. A row number sent again replaces that row`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(IMPORT_LIMITS.maxRowsPerBatch)
  rows: unknown[];
}

export class ConfirmMovementImportDto {
  @ApiProperty({
    example: 1,
    description: 'The revision of the validation being confirmed',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision: number;
}

export enum IssueSeverityFilter {
  ERROR = 'ERROR',
  WARNING = 'WARNING',
}

export class ImportIssuesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: IssueSeverityFilter,
    enumName: 'ImportIssueSeverity',
  })
  @IsOptional()
  @IsEnum(IssueSeverityFilter)
  severity?: IssueSeverityFilter;

  @ApiPropertyOptional({ example: 'UNKNOWN_SKU' })
  @IsOptional()
  @Matches(/^[A-Z_]{1,40}$/)
  code?: string;
}

export enum HistoricalMovementCode {
  OPENING_BALANCE = 'OPENING_BALANCE',
  PURCHASE_RECEIPT = 'PURCHASE_RECEIPT',
  SALE = 'SALE',
  INTERNAL_CONSUMPTION = 'INTERNAL_CONSUMPTION',
  ADJUSTMENT_IN = 'ADJUSTMENT_IN',
  ADJUSTMENT_OUT = 'ADJUSTMENT_OUT',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
}

export class HistoricalMovementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  warehouseId?: number;

  @ApiPropertyOptional({ example: '2025-01-01', description: 'From this date' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({
    example: '2025-12-31',
    description: 'Up to this date',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    enum: HistoricalMovementCode,
    enumName: 'HistoricalMovementCode',
  })
  @IsOptional()
  @IsEnum(HistoricalMovementCode)
  movementType?: HistoricalMovementCode;

  @ApiPropertyOptional({
    example: 3,
    description: 'Only the lines of this import',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  importId?: number;
}
