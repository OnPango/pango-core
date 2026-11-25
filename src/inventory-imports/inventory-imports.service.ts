import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import type { InventoryImportStatus } from '../generated/prisma/tenant/enums.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { isUniqueViolation } from '../prisma/prisma-errors.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import { checkBatchRows, type RowValues } from './batch.js';
import type {
  AppendInventoryRowsDto,
  CreateInventoryImportDto,
  ListInventoryImportsQueryDto,
} from './dto.js';
import {
  checkMapping,
  type ColumnMapping,
  type FieldDefinition,
  FIELDS,
  SCHEMA_VERSION,
  UNIT_ALIASES,
} from './fields.js';
import { InventoryImportConfig } from './inventory-import-config.js';
import { inventoryImportErrors } from './inventory-import-errors.js';
import { type ImportScope, importScope } from './inventory-import-access.js';
import { loadLookups } from './lookups.js';
import { parseRow } from './parse.js';
import type {
  AppendInventoryRowsResultDto,
  InventoryImportDto,
  InventoryImportFieldDto,
  InventoryImportFieldsDto,
  InventoryImportIssuePageDto,
  InventoryImportPageDto,
  InventoryImportReportDto,
} from './responses.js';
import { type ValidationResult, validateRows } from './validate.js';

type Tx = Prisma.TransactionClient;

/** Statuses of an import still open: at most one per organization. */
export const OPEN_STATUSES: InventoryImportStatus[] = [
  'RECEIVING',
  'READY',
  'INVALID',
];

const importInclude = {
  createdBy: { select: { id: true, accountId: true } },
} satisfies Prisma.InventoryImportInclude;

type ImportRecord = Prisma.InventoryImportGetPayload<{
  include: typeof importInclude;
}>;

/** JSON with object keys sorted, so equal content always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Warehouses an import touches, as stored by its validation and confirmation. */
function touchedWarehouses(record: { summary: Prisma.JsonValue }): number[] {
  const ids = (record.summary as { warehouseIds?: unknown } | null)
    ?.warehouseIds;
  return Array.isArray(ids)
    ? ids.filter((id): id is number => Number.isInteger(id))
    : [];
}

/**
 * INV-BR-17: the creator sees their import; others see it when they may import
 * into every warehouse it touches (always, for the Owner). An import that
 * touches no warehouse yet is visible to its creator and the Owner only.
 */
export function canSee(
  record: { createdById: number; summary: Prisma.JsonValue },
  userId: number,
  scope: ImportScope,
): boolean {
  if (record.createdById === userId || scope === 'ALL') return true;
  const touched = touchedWarehouses(record);
  return touched.length > 0 && touched.every((id) => scope.includes(id));
}

// Inventory import sessions (docs/modules/inventary.md): creation, reading,
// cancellation, history and lazy expiry. Rows, validation and confirmation come
// in later stages.
@Injectable()
export class InventoryImportsService {
  constructor(
    private readonly tenants: TenantPrismaService,
    private readonly control: ControlPrismaService,
    private readonly config: InventoryImportConfig,
  ) {}

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  async fields(auth: AuthContext): Promise<InventoryImportFieldsDto> {
    const units = await this.tenant(auth).unitOfMeasure.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true },
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      limits: {
        maxRowsPerBatch: this.config.maxBatchRows,
        maxRowsPerImport: this.config.maxRows,
        maxRequestBytes: this.config.maxRequestBytes,
        maxValueChars: this.config.maxValueChars,
        expiryHours: this.config.expiryHours,
      },
      fields: FIELDS.map(toFieldDto),
      units: units.map((u) => ({
        code: u.code,
        name: u.name,
        aliases: [...(UNIT_ALIASES[u.code] ?? [])],
      })),
    };
  }

  /**
   * Starts an import, or answers the one this `clientRequestId` already started
   * (`replayed`). One open import per organization; the database enforces it
   * (`inventory_imports_open_key`), so a concurrent loser gets the same answers.
   */
  async create(
    auth: AuthContext,
    dto: CreateInventoryImportDto,
  ): Promise<{ import: InventoryImportDto; replayed: boolean }> {
    if (dto.schemaVersion !== SCHEMA_VERSION) {
      throw inventoryImportErrors.unsupportedSchemaVersion();
    }
    const { mapping, problems } = checkMapping(dto.mapping);
    if (problems.length > 0)
      throw inventoryImportErrors.mappingInvalid(problems);
    if (dto.totalRows > this.config.maxRows) {
      throw inventoryImportErrors.limitExceeded(this.config.maxRows);
    }
    const requestFingerprint = fingerprint({
      schemaVersion: dto.schemaVersion,
      fileName: dto.fileName,
      sheetName: dto.sheetName,
      totalRows: dto.totalRows,
      mapping,
    });
    const schema = assertTenantSchema(auth.organization.schemaName);
    const tenant = this.tenant(auth);

    try {
      const outcome = await tenant.$transaction(async (tx) => {
        await this.expireStale(tx, schema);
        const existing = await this.byRequest(tx, auth, dto.clientRequestId);
        if (existing) {
          return {
            record: replay(existing, requestFingerprint),
            replayed: true,
          };
        }
        await this.assertNoOpenImport(tx, auth);
        const record = await tx.inventoryImport.create({
          data: {
            clientRequestId: dto.clientRequestId,
            createdById: auth.user.id,
            schemaVersion: dto.schemaVersion,
            fileName: dto.fileName.trim(),
            sheetName: dto.sheetName.trim(),
            totalRows: dto.totalRows,
            mapping: mapping as Prisma.InputJsonValue,
            requestFingerprint,
          },
          include: importInclude,
        });
        return { record, replayed: false };
      });
      return {
        import: (await this.toDtos([outcome.record]))[0],
        replayed: outcome.replayed,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent request committed first: answer as if it had come first.
      const existing = await this.byRequest(tenant, auth, dto.clientRequestId);
      if (existing) {
        const record = replay(existing, requestFingerprint);
        return { import: (await this.toDtos([record]))[0], replayed: true };
      }
      await this.assertNoOpenImport(tenant, auth);
      throw error;
    }
  }

  /**
   * Stores a batch of rows. The same batch again (same number, same rows) answers
   * what it answered the first time and changes nothing; other rows under that
   * number, or a row number already received, are refused. Batches of one import
   * are stored one at a time (the import's row lock).
   */
  async appendRows(
    auth: AuthContext,
    id: number,
    dto: AppendInventoryRowsDto,
  ): Promise<AppendInventoryRowsResultDto> {
    if (dto.rows.length > this.config.maxBatchRows) {
      throw inventoryImportErrors.batchTooLarge(this.config.maxBatchRows);
    }
    const { rows, problems } = checkBatchRows(
      dto.rows,
      this.config.maxValueChars,
    );
    if (problems.length > 0) throw inventoryImportErrors.rowsInvalid(problems);
    const payloadHash = fingerprint(
      [...rows].sort((a, b) => a.rowNumber - b.rowNumber),
    );
    const schema = assertTenantSchema(auth.organization.schemaName);

    return this.tenant(auth).$transaction(
      async (tx) => {
        await this.expireStale(tx, schema);
        const current = await this.lockOwn(tx, schema, auth, id);
        const now = new Date();

        const stored = await tx.inventoryImportBatch.findUnique({
          where: {
            importId_batchNumber: {
              importId: id,
              batchNumber: dto.batchNumber,
            },
          },
        });
        if (stored) {
          if (stored.payloadHash !== payloadHash) {
            throw inventoryImportErrors.batchConflict(
              `Batch ${dto.batchNumber} was already received with other rows`,
            );
          }
          await tx.inventoryImport.update({
            where: { id },
            data: { lastActivityAt: now },
          });
          return {
            importId: id,
            batchNumber: dto.batchNumber,
            acceptedRows: stored.rowCount,
            receivedRows: stored.receivedRowsAfter,
            totalRows: current.totalRows,
            status: current.status,
            replayed: true,
          };
        }

        if (!OPEN_STATUSES.includes(current.status)) {
          throw inventoryImportErrors.closed();
        }
        if (current.status !== 'RECEIVING') {
          throw inventoryImportErrors.notReceiving();
        }
        const taken = await tx.inventoryImportRow.findFirst({
          where: {
            importId: id,
            rowNumber: { in: rows.map((r) => r.rowNumber) },
          },
          select: { rowNumber: true, batchNumber: true },
          orderBy: { rowNumber: 'asc' },
        });
        if (taken) {
          throw inventoryImportErrors.batchConflict(
            `Row ${taken.rowNumber} was already received in batch ${taken.batchNumber}`,
          );
        }
        const receivedRows = current.receivedRows + rows.length;
        if (receivedRows > current.totalRows) {
          throw inventoryImportErrors.rowsExceedTotal(
            receivedRows,
            current.totalRows,
          );
        }

        await tx.inventoryImportRow.createMany({
          data: rows.map((row) => ({
            importId: id,
            rowNumber: row.rowNumber,
            batchNumber: dto.batchNumber,
            values: row.values,
          })),
        });
        await tx.inventoryImportBatch.create({
          data: {
            importId: id,
            batchNumber: dto.batchNumber,
            payloadHash,
            rowCount: rows.length,
            receivedRowsAfter: receivedRows,
          },
        });
        await tx.inventoryImport.update({
          where: { id },
          data: { receivedRows, lastActivityAt: now },
        });
        return {
          importId: id,
          batchNumber: dto.batchNumber,
          acceptedRows: rows.length,
          receivedRows,
          totalRows: current.totalRows,
          status: current.status,
          replayed: false,
        };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Validates every received row against the organization's current data and
   * stores the result as a new revision: row statuses and previews, the first
   * issues, the summary and the outcome's fingerprint (compared on
   * confirmation). Nothing definitive is written.
   */
  async validate(
    auth: AuthContext,
    id: number,
  ): Promise<InventoryImportReportDto> {
    const schema = assertTenantSchema(auth.organization.schemaName);
    await this.tenant(auth).$transaction(
      async (tx) => {
        await this.expireStale(tx, schema);
        const current = await this.lockOwn(tx, schema, auth, id);
        if (!OPEN_STATUSES.includes(current.status)) {
          throw inventoryImportErrors.closed();
        }
        if (current.receivedRows < current.totalRows) {
          throw inventoryImportErrors.incomplete(
            current.receivedRows,
            current.totalRows,
          );
        }
        const result = await this.runValidation(tx, schema, auth, id);
        await this.storeValidation(tx, id, result);
        await tx.inventoryImport.update({
          where: { id },
          data: {
            status: result.summary.errors === 0 ? 'READY' : 'INVALID',
            revision: { increment: 1 },
            summary: result.summary as unknown as Prisma.InputJsonValue,
            validationFingerprint: outcomeFingerprint(result),
            lastActivityAt: new Date(),
          },
        });
      },
      { timeout: 120_000 },
    );
    return {
      import: await this.get(auth, id),
      issues: await this.issuePage(auth, id, {}),
    };
  }

  /** Parses the staged rows and applies every rule, reading inside `tx`. */
  async runValidation(
    tx: Tx,
    schema: string,
    auth: AuthContext,
    id: number,
  ): Promise<ValidationResult> {
    const stored = await tx.inventoryImportRow.findMany({
      where: { importId: id },
      orderBy: { rowNumber: 'asc' },
      select: { rowNumber: true, values: true },
    });
    const parsed = stored.map((r) =>
      parseRow(r.rowNumber, r.values as RowValues),
    );
    const lookups = await loadLookups(
      tx,
      schema,
      auth,
      parsed.map((p) => p.row),
    );
    return validateRows(parsed, lookups);
  }

  /** Replaces the rows' status and preview and the stored issues. */
  private async storeValidation(tx: Tx, id: number, result: ValidationResult) {
    const previews = new Map(result.rows.map((r) => [r.rowNumber, r]));
    const stored = await tx.inventoryImportRow.findMany({
      where: { importId: id },
      select: { rowNumber: true, batchNumber: true, values: true },
    });
    await tx.inventoryImportIssue.deleteMany({ where: { importId: id } });
    await tx.inventoryImportRow.deleteMany({ where: { importId: id } });
    for (let i = 0; i < stored.length; i += STORE_CHUNK) {
      await tx.inventoryImportRow.createMany({
        data: stored.slice(i, i + STORE_CHUNK).map((row) => {
          const preview = previews.get(row.rowNumber)!;
          return {
            importId: id,
            rowNumber: row.rowNumber,
            batchNumber: row.batchNumber,
            values: row.values as Prisma.InputJsonValue,
            status: preview.status,
            preview: preview as unknown as Prisma.InputJsonValue,
            issueCount: preview.issues,
          };
        }),
      });
    }
    const kept = result.issues.slice(0, this.config.maxStoredIssues);
    for (let i = 0; i < kept.length; i += STORE_CHUNK) {
      await tx.inventoryImportIssue.createMany({
        data: kept.slice(i, i + STORE_CHUNK).map((issue) => ({
          importId: id,
          rowNumber: issue.rowNumber,
          field: issue.field,
          severity: issue.severity,
          code: issue.code,
          message: issue.message.slice(0, 300),
          value: issue.value,
        })),
      });
    }
  }

  /** A page of the last validation's issues, by row, with their source column. */
  async issuePage(
    auth: AuthContext,
    id: number,
    query: {
      page?: number;
      pageSize?: number;
      severity?: 'ERROR' | 'WARNING';
      code?: string;
    },
  ): Promise<InventoryImportIssuePageDto> {
    const record = await this.readable(auth, id);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.InventoryImportIssueWhereInput = {
      importId: id,
      ...(query.severity && { severity: query.severity }),
      ...(query.code && { code: query.code }),
    };
    const tenant = this.tenant(auth);
    const [total, items] = await Promise.all([
      tenant.inventoryImportIssue.count({ where }),
      tenant.inventoryImportIssue.findMany({
        where,
        orderBy: [
          { rowNumber: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const mapping = record.mapping as ColumnMapping;
    return {
      items: items.map((issue) => ({
        rowNumber: issue.rowNumber,
        field: issue.field,
        sourceColumn:
          (issue.field && mapping[issue.field as keyof ColumnMapping]) || null,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        value: issue.value,
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(auth: AuthContext, id: number): Promise<InventoryImportDto> {
    const record = await this.readable(auth, id);
    return (await this.toDtos([record]))[0];
  }

  /**
   * Cancels an open import and deletes its staged data. Cancelling a cancelled
   * or expired import answers it as it is; a completed one cannot be cancelled.
   */
  async cancel(auth: AuthContext, id: number): Promise<InventoryImportDto> {
    const schema = assertTenantSchema(auth.organization.schemaName);
    const record = await this.tenant(auth).$transaction(async (tx) => {
      await this.expireStale(tx, schema);
      const current = await this.lockOwn(tx, schema, auth, id);
      if (current.status === 'COMPLETED') throw inventoryImportErrors.closed();
      if (!OPEN_STATUSES.includes(current.status)) return current;
      await deleteStaged(tx, [id]);
      return tx.inventoryImport.update({
        where: { id },
        data: { status: 'CANCELLED', lastActivityAt: new Date() },
        include: importInclude,
      });
    });
    return (await this.toDtos([record]))[0];
  }

  /** Imports the user may see (INV-BR-17), newest first. */
  async list(
    auth: AuthContext,
    query: ListInventoryImportsQueryDto,
  ): Promise<InventoryImportPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const schema = assertTenantSchema(auth.organization.schemaName);
    const tenant = this.tenant(auth);
    await tenant.$transaction((tx) => this.expireStale(tx, schema));

    const scope = importScope(auth);
    const filters = [
      query.status ?? null,
      scope === 'ALL',
      auth.user.id,
      scope === 'ALL' ? [] : scope,
    ];
    const where = `
      WHERE ($1::text IS NULL OR i."status"::text = $1)
        AND ($2::boolean OR i."created_by_id" = $3 OR (
              jsonb_typeof(i."summary"->'warehouseIds') = 'array'
              AND jsonb_array_length(i."summary"->'warehouseIds') > 0
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(i."summary"->'warehouseIds') w
                 WHERE NOT (w::int = ANY($4::int[])))))`;
    const [[{ total }], ids] = await Promise.all([
      tenant.$queryRawUnsafe<{ total: number }[]>(
        `SELECT COUNT(*)::int AS "total" FROM "${schema}"."inventory_imports" i ${where}`,
        ...filters,
      ),
      tenant.$queryRawUnsafe<{ id: number }[]>(
        `SELECT i."id" FROM "${schema}"."inventory_imports" i ${where}
          ORDER BY i."created_at" DESC, i."id" DESC LIMIT $5 OFFSET $6`,
        ...filters,
        pageSize,
        (page - 1) * pageSize,
      ),
    ]);
    const records = await tenant.inventoryImport.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      include: importInclude,
    });
    const order = new Map(ids.map((r, index) => [r.id, index]));
    records.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { items: await this.toDtos(records), total, page, pageSize };
  }

  /**
   * Expires the open imports idle for longer than the configured hours and
   * deletes their staged data, in the caller's transaction. Re-checking the
   * activity in the UPDATE leaves alone an import that a concurrent request just
   * touched.
   */
  async expireStale(tx: Tx, schema: string): Promise<void> {
    const cutoff = new Date(Date.now() - this.config.expiryHours * 3_600_000);
    const expired = await tx.$queryRawUnsafe<{ id: number }[]>(
      `UPDATE "${schema}"."inventory_imports"
          SET "status" = 'EXPIRED', "updated_at" = now()
        WHERE "status" IN ('RECEIVING', 'READY', 'INVALID') AND "last_activity_at" < $1
        RETURNING "id"`,
      cutoff,
    );
    if (expired.length > 0)
      await deleteStaged(
        tx,
        expired.map((r) => r.id),
      );
  }

  /**
   * Locks an import for a change by its creator. An import the user may not see
   * does not exist for them; one they see but did not start is not theirs.
   */
  async lockOwn(
    tx: Tx,
    schema: string,
    auth: AuthContext,
    id: number,
  ): Promise<ImportRecord> {
    await tx.$executeRawUnsafe(
      `SELECT 1 FROM "${schema}"."inventory_imports" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
    const record = await tx.inventoryImport.findUnique({
      where: { id },
      include: importInclude,
    });
    if (!record || !canSee(record, auth.user.id, importScope(auth))) {
      throw inventoryImportErrors.notFound();
    }
    if (record.createdById !== auth.user.id) {
      throw inventoryImportErrors.notYours();
    }
    return record;
  }

  private async readable(auth: AuthContext, id: number) {
    const schema = assertTenantSchema(auth.organization.schemaName);
    const tenant = this.tenant(auth);
    await tenant.$transaction((tx) => this.expireStale(tx, schema));
    const record = await tenant.inventoryImport.findUnique({
      where: { id },
      include: importInclude,
    });
    if (!record || !canSee(record, auth.user.id, importScope(auth))) {
      throw inventoryImportErrors.notFound();
    }
    return record;
  }

  private byRequest(tx: Tx, auth: AuthContext, clientRequestId: string) {
    return tx.inventoryImport.findUnique({
      where: {
        createdById_clientRequestId: {
          createdById: auth.user.id,
          clientRequestId,
        },
      },
      include: importInclude,
    });
  }

  /** 409 when an import is open; its id is shown to its creator only. */
  private async assertNoOpenImport(tx: Tx, auth: AuthContext) {
    const open = await tx.inventoryImport.findFirst({
      where: { status: { in: OPEN_STATUSES } },
      select: { id: true, createdById: true },
    });
    if (open) {
      throw inventoryImportErrors.activeExists(
        open.createdById === auth.user.id ? open.id : undefined,
      );
    }
  }

  private async toDtos(records: ImportRecord[]): Promise<InventoryImportDto[]> {
    const accountIds = [...new Set(records.map((r) => r.createdBy.accountId))];
    const accounts =
      accountIds.length === 0
        ? []
        : await this.control.account.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, name: true },
          });
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    const expiryMs = this.config.expiryHours * 3_600_000;
    return records.map((r) => ({
      id: r.id,
      status: r.status,
      schemaVersion: r.schemaVersion,
      fileName: r.fileName,
      sheetName: r.sheetName,
      totalRows: r.totalRows,
      receivedRows: r.receivedRows,
      revision: r.revision,
      summary: publicSummary(r.summary),
      result: (r.result as Record<string, unknown> | null) ?? null,
      createdBy: {
        id: r.createdBy.id,
        name: names.get(r.createdBy.accountId) ?? null,
      },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      expiresAt: OPEN_STATUSES.includes(r.status)
        ? new Date(r.lastActivityAt.getTime() + expiryMs)
        : null,
      confirmedAt: r.confirmedAt,
    }));
  }
}

/** The same request again returns its import; other content under the same id is refused. */
function replay(record: ImportRecord, requestFingerprint: string) {
  if (record.requestFingerprint !== requestFingerprint) {
    throw inventoryImportErrors.idempotencyConflict();
  }
  return record;
}

/** Rows written per statement when storing a validation. */
const STORE_CHUNK = 1000;

/**
 * What a validation decided, to tell on confirmation whether anything changed:
 * every row's status and resolution, every issue, and the plan.
 */
export function outcomeFingerprint(result: ValidationResult): string {
  return fingerprint({
    rows: result.rows,
    issues: result.issues.map((i) => [i.rowNumber, i.field, i.code]),
    plan: result.plan,
  });
}

/** Deletes the batches, rows and issues of imports that are closing. */
export async function deleteStaged(tx: Tx, importIds: number[]) {
  const where = { importId: { in: importIds } };
  await tx.inventoryImportIssue.deleteMany({ where });
  await tx.inventoryImportRow.deleteMany({ where });
  await tx.inventoryImportBatch.deleteMany({ where });
}

/** The summary without the internal list of touched warehouses. */
function publicSummary(
  summary: Prisma.JsonValue,
): Record<string, unknown> | null {
  if (
    summary === null ||
    typeof summary !== 'object' ||
    Array.isArray(summary)
  ) {
    return null;
  }
  const { warehouseIds: _warehouseIds, ...rest } = summary;
  return rest;
}

function toFieldDto(field: FieldDefinition): InventoryImportFieldDto {
  return {
    key: field.key,
    label: field.label,
    required: field.required,
    type: field.type,
    ...(field.maxLength !== undefined && { maxLength: field.maxLength }),
    ...(field.min !== undefined && { min: field.min }),
    ...(field.max !== undefined && { max: field.max }),
    ...(field.maxDecimals !== undefined && { maxDecimals: field.maxDecimals }),
    ...(field.values !== undefined && { values: [...field.values] }),
    ...(field.requiredWhen !== undefined && {
      requiredWhen: { ...field.requiredWhen },
    }),
  };
}
