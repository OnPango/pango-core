import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Every JSON body of the API is limited to 1 MB (`src/main.ts`); batches must fit in it. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * Operational limits of inventory imports (docs/modules/inventary.md,
 * "Configuration"). Read once at start-up; an invalid value stops the app.
 */
@Injectable()
export class InventoryImportConfig {
  /** Rows per import (ADR-INV-013). */
  readonly maxRows: number;
  /** Rows per batch request. */
  readonly maxBatchRows: number;
  /** Hours without activity after which an open import expires. */
  readonly expiryHours: number;
  /** Longest a confirmation transaction may run. */
  readonly confirmTimeoutMs: number;
  readonly maxRequestBytes = MAX_REQUEST_BYTES;
  /** Characters of one value as sent. */
  readonly maxValueChars = 2000;
  /**
   * Characters of all the values of one row. A real row fits (a 2,000-character
   * description plus every other field); it bounds what an import can stage.
   */
  readonly maxRowChars = 4096;
  /** Issues stored per validation (all are counted). */
  readonly maxStoredIssues = 10_000;

  constructor(config: ConfigService) {
    this.maxRows = positiveInteger(config, 'INVENTORY_IMPORT_MAX_ROWS', 5000);
    this.maxBatchRows = positiveInteger(
      config,
      'INVENTORY_IMPORT_MAX_BATCH_ROWS',
      5000,
    );
    this.expiryHours = positiveInteger(
      config,
      'INVENTORY_IMPORT_EXPIRY_HOURS',
      24,
    );
    this.confirmTimeoutMs = positiveInteger(
      config,
      'INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS',
      120_000,
    );
  }
}

function positiveInteger(
  config: ConfigService,
  name: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(name);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}
