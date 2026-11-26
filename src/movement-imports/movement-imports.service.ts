import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { localToday } from '../demand/demand.service.js';
import type { PageQueryDto } from '../forecasting/dto.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import type {
  AppendImportRowsDto,
  ConfirmMovementImportDto,
  CreateMovementImportDto,
  HistoricalMovementsQueryDto,
  ImportIssuesQueryDto,
} from './dto.js';
import { beforeCutover, pangoStartSql } from './history-sql.js';
import {
  IMPORT_LIMITS,
  type IncomingRow,
  MOVEMENT_CODES,
  rowShapeProblem,
  rowValues,
} from './import-format.js';
import { movementImportErrors } from './movement-import-errors.js';
import { normalize, type ParsedRow } from './normalize.js';
import type {
  AppendRowsResultDto,
  HistoricalMovementPageDto,
  ImportBalancePageDto,
  MovementImportDto,
  MovementImportReportDto,
} from './responses.js';
import {
  DEFAULT_LOCATION,
  historyFingerprint,
  type Lookups,
  sourceKey,
  validate,
  type ValidatedRow,
} from './validate.js';

type Tx = Prisma.TransactionClient;

const IMPORT = 'movement.import';
const READ = 'movement.read';
const CHUNK = 2000;

const lower = (value: string) => value.toLowerCase();

const unique = <T>(values: (T | undefined)[]) => [
  ...new Set(values.filter((v): v is T => v !== undefined)),
];

const day = (date: Date) => date.toISOString().slice(0, 10);

const num = (value: string | null) => (value === null ? null : Number(value));

type ImportRecord = Prisma.MovementImportGetPayload<object>;

function toDto(record: ImportRecord): MovementImportDto {
  return {
    id: record.id,
    sourceNamespace: record.sourceNamespace,
    fileName: record.fileName,
    status: record.status,
    revision: record.revision,
    rowCount: record.rowCount,
    validRowCount: record.validRowCount,
    invalidRowCount: record.invalidRowCount,
    duplicateRowCount: record.duplicateRowCount,
    issueCounts: record.issueCounts as Record<string, number>,
    uploadedById: record.uploadedById,
    confirmedAt: record.confirmedAt,
    savedCount: record.savedCount,
    skippedCount: record.skippedCount,
    createdAt: record.createdAt,
  };
}

/** The rows of a batch, or the problems that reject it. */
export function checkBatch(sent: unknown[]): {
  rows: IncomingRow[];
  problems: string[];
} {
  const problems: string[] = [];
  const rows: IncomingRow[] = [];
  const seen = new Set<number>();
  sent.forEach((row, index) => {
    const problem = rowShapeProblem(row);
    if (problem) {
      problems.push(`rows[${index}]: ${problem}`);
      return;
    }
    const { rowNumber, values } = row as { rowNumber: number; values: object };
    if (seen.has(rowNumber)) {
      problems.push(`rows[${index}]: rowNumber ${rowNumber} is repeated`);
      return;
    }
    seen.add(rowNumber);
    rows.push({ rowNumber, values: rowValues(values) });
  });
  return { rows, problems };
}

// CU-17: importing a company's movement history from before Pango. The frontend
// maps the company's file onto the v1 template and sends the rows in batches;
// they are validated against the organization's data (read only) and, once
// confirmed, saved into historical_movements. Nothing else is written: imported
// history never changes stock, costs, alerts or the catalog, and inventory never
// reads it. Demand and the forecast input read it before each product's first
// Pango movement in each warehouse (see history-sql.ts).
@Injectable()
export class MovementImportsService {
  constructor(private readonly tenants: TenantPrismaService) {}

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  async create(
    auth: AuthContext,
    dto: CreateMovementImportDto,
  ): Promise<MovementImportDto> {
    const record = await this.tenant(auth).movementImport.create({
      data: {
        sourceNamespace: lower(dto.sourceNamespace),
        fileName: dto.fileName?.trim() || null,
        uploadedById: auth.user.id,
      },
    });
    return toDto(record);
  }

  /** Locks the import for a change by the user who started it. */
  private async lockOwn(
    tx: Tx,
    schema: string,
    auth: AuthContext,
    id: number,
  ): Promise<ImportRecord> {
    await tx.$queryRawUnsafe(
      `SELECT 1 FROM "${schema}"."movement_imports" WHERE "id" = $1 FOR UPDATE`,
      id,
    );
    const record = await tx.movementImport.findUnique({ where: { id } });
    if (!record) throw movementImportErrors.notFound();
    if (record.uploadedById !== auth.user.id) {
      throw movementImportErrors.notUploader();
    }
    return record;
  }

  /**
   * Adds a batch of rows. A row number sent again replaces that row, so a
   * retried batch has the same effect. Sending rows reopens a validated import.
   */
  async appendRows(
    auth: AuthContext,
    id: number,
    dto: AppendImportRowsDto,
  ): Promise<AppendRowsResultDto> {
    const { rows, problems } = checkBatch(dto.rows);
    if (problems.length > 0) throw movementImportErrors.rowsInvalid(problems);

    const schema = assertTenantSchema(auth.organization.schemaName);
    const record = await this.tenant(auth).$transaction(
      async (tx) => {
        const current = await this.lockOwn(tx, schema, auth, id);
        if (current.status === 'CONFIRMED') {
          throw movementImportErrors.confirmed();
        }
        const { count: replaced } = await tx.movementImportRow.deleteMany({
          where: {
            importId: id,
            rowNumber: { in: rows.map((r) => r.rowNumber) },
          },
        });
        const rowCount = current.rowCount - replaced + rows.length;
        if (rowCount > IMPORT_LIMITS.maxRows) {
          throw movementImportErrors.tooManyRows();
        }
        await tx.movementImportRow.createMany({
          data: rows.map((r) => ({
            importId: id,
            rowNumber: r.rowNumber,
            source: r.values,
          })),
        });
        return tx.movementImport.update({
          where: { id },
          data: { status: 'RECEIVING', rowCount },
        });
      },
      { timeout: 60_000 },
    );
    return { received: rows.length, import: toDto(record) };
  }

  /**
   * Validates every row received against the organization's data (reading
   * only), stores the result as a new revision and answers the preview.
   */
  async validate(
    auth: AuthContext,
    id: number,
  ): Promise<MovementImportReportDto> {
    const schema = assertTenantSchema(auth.organization.schemaName);
    await this.tenant(auth).$transaction(
      async (tx) => {
        const current = await this.lockOwn(tx, schema, auth, id);
        if (current.status === 'CONFIRMED') {
          throw movementImportErrors.confirmed();
        }
        if (current.rowCount === 0) throw movementImportErrors.empty();

        const stored = await tx.movementImportRow.findMany({
          where: { importId: id },
          orderBy: { rowNumber: 'asc' },
          select: { rowNumber: true, source: true },
        });
        const sources = new Map(stored.map((r) => [r.rowNumber, r.source]));
        const parsed = normalize(
          stored.map((r) => ({
            rowNumber: r.rowNumber,
            values: rowValues(r.source as object),
          })),
        );
        const [lookups, today, existing] = await Promise.all([
          this.lookups(tx, schema, auth, parsed.rows),
          this.today(tx),
          this.existing(tx, current.sourceNamespace, parsed.rows),
        ]);
        const { rows, issues } = validate(parsed.rows, parsed.issues, lookups, {
          today,
          existing,
        });

        await tx.movementImportRow.deleteMany({ where: { importId: id } });
        await tx.movementImportIssue.deleteMany({ where: { importId: id } });
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx.movementImportRow.createMany({
            data: rows
              .slice(i, i + CHUNK)
              .map((r) => stagedRow(id, r, sources.get(r.rowNumber) ?? {})),
          });
        }
        const kept = issues.slice(0, IMPORT_LIMITS.maxStoredIssues);
        for (let i = 0; i < kept.length; i += CHUNK) {
          await tx.movementImportIssue.createMany({
            data: kept.slice(i, i + CHUNK).map((issue) => ({
              importId: id,
              rowNumber: issue.rowNumber,
              field: issue.field,
              severity: issue.severity,
              code: issue.code,
              message: issue.message.slice(0, 300),
              value: issue.value?.slice(0, 200) ?? null,
            })),
          });
        }
        const counts: Record<string, number> = {};
        for (const i of issues) counts[i.code] = (counts[i.code] ?? 0) + 1;
        const count = (status: ValidatedRow['status']) =>
          rows.filter((r) => r.status === status).length;
        await tx.movementImport.update({
          where: { id },
          data: {
            status: 'VALIDATED',
            revision: { increment: 1 },
            validRowCount: count('VALID'),
            invalidRowCount: count('INVALID'),
            duplicateRowCount: count('DUPLICATE'),
            issueCounts: counts,
          },
        });
      },
      { timeout: 300_000 },
    );
    return this.report(auth, id, {});
  }

  /**
   * Saves the valid rows of the validated revision into historical_movements.
   * Confirmations of one organization run one at a time, so two imports of the
   * same source lines cannot both save them. A repeated confirmation answers the
   * first one's result.
   */
  async confirm(
    auth: AuthContext,
    id: number,
    dto: ConfirmMovementImportDto,
  ): Promise<MovementImportDto> {
    const schema = assertTenantSchema(auth.organization.schemaName);
    const record = await this.tenant(auth).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          `${schema}:movement-import-confirm`,
        );
        const current = await this.lockOwn(tx, schema, auth, id);
        if (current.status === 'CONFIRMED') return current;
        if (current.status !== 'VALIDATED') {
          throw movementImportErrors.notValidated();
        }
        if (current.revision !== dto.revision)
          throw movementImportErrors.stale();
        if (current.validRowCount === 0) {
          throw movementImportErrors.nothingToSave();
        }

        // The user may still import in every warehouse of the valid rows.
        const scope = warehousesWithPermission(auth.user.roles, IMPORT);
        if (scope !== 'ALL') {
          const outside = await tx.movementImportRow.count({
            where: {
              importId: id,
              status: 'VALID',
              warehouseId: { notIn: scope },
            },
          });
          if (outside > 0) throw movementImportErrors.stale();
        }
        // Another import may have saved some of these lines since validation.
        const [{ taken }] = await tx.$queryRawUnsafe<{ taken: number }[]>(
          `SELECT COUNT(*)::int AS "taken"
             FROM "${schema}"."movement_import_rows" r
             JOIN "${schema}"."historical_movements" h
               ON h."source_namespace" = $2
              AND h."external_movement_id" = r."external_movement_id"
              AND h."line_number" = r."line_number" AND h."leg" = r."leg"
            WHERE r."import_id" = $1 AND r."status" = 'VALID'`,
          id,
          current.sourceNamespace,
        );
        if (taken > 0) throw movementImportErrors.stale();

        const saved = await tx.$executeRawUnsafe(
          `INSERT INTO "${schema}"."historical_movements" (
             "import_id", "source_row_number", "source_namespace", "external_movement_id",
             "line_number", "leg", "movement_code", "movement_type_id", "business_date",
             "warehouse_id", "product_id", "location_code", "lot_code", "quantity_in",
             "quantity_out", "balance_after", "running_balance", "demand_quantity",
             "unit_cost", "document_ref")
           SELECT "import_id", "row_number", $2, "external_movement_id", "line_number",
                  "leg", "movement_code", "movement_type_id", "business_date",
                  "warehouse_id", "product_id", "location_code", "lot_code", "quantity_in",
                  "quantity_out", "balance_after", "running_balance", "demand_quantity",
                  "unit_cost", "document_ref"
             FROM "${schema}"."movement_import_rows"
            WHERE "import_id" = $1 AND "status" = 'VALID'
            ORDER BY "row_number"`,
          id,
          current.sourceNamespace,
        );
        return tx.movementImport.update({
          where: { id },
          data: {
            status: 'CONFIRMED',
            confirmedAt: new Date(),
            savedCount: saved,
            skippedCount: current.duplicateRowCount,
          },
        });
      },
      { timeout: 120_000 },
    );
    return toDto(record);
  }

  private async today(tx: Tx): Promise<string> {
    const settings = await tx.settings.findUnique({ where: { id: 1 } });
    return localToday(settings?.timeZone ?? 'America/Bogota');
  }

  /** Lines already in the history under the rows' source keys, as fingerprints. */
  private async existing(
    tx: Tx,
    namespace: string,
    rows: ParsedRow[],
  ): Promise<Map<string, string>> {
    const ids = unique(rows.map((r) => r.externalMovementId));
    if (ids.length === 0) return new Map();
    const lines = await tx.historicalMovement.findMany({
      where: { sourceNamespace: namespace, externalMovementId: { in: ids } },
    });
    return new Map(
      lines.map((h) => [
        sourceKey(h)!,
        historyFingerprint({
          businessDate: day(h.businessDate),
          warehouseId: h.warehouseId,
          productId: h.productId,
          movementCode: h.movementCode,
          quantityIn: h.quantityIn,
          quantityOut: h.quantityOut,
          locationCode: h.locationCode,
          lotCode: h.lotCode,
          unitCost: h.unitCost,
        }),
      ]),
    );
  }

  /** Tenant data for the codes the rows mention, limited to what the user may import. */
  private async lookups(
    tx: Tx,
    schema: string,
    auth: AuthContext,
    rows: ParsedRow[],
  ): Promise<Lookups> {
    const scope = warehousesWithPermission(auth.user.roles, IMPORT);
    const warehouseCodes = unique(
      rows.map((r) => r.warehouseCode && lower(r.warehouseCode)),
    );
    const skus = unique(rows.map((r) => r.sku && lower(r.sku)));
    const typeNames = [
      ...new Set([...MOVEMENT_CODES.values()].map((c) => c.typeName)),
    ];

    const [warehouseRows, productRows, typeRows, assignments] =
      await Promise.all([
        warehouseCodes.length === 0
          ? []
          : tx.$queryRawUnsafe<{ id: number; code: string }[]>(
              `SELECT "id", "code" FROM "${schema}"."warehouses"
                WHERE lower("code") = ANY($1::text[])`,
              warehouseCodes,
            ),
        skus.length === 0
          ? []
          : tx.$queryRawUnsafe<
              {
                id: number;
                sku: string;
                tracksLots: boolean;
                unitCode: string;
              }[]
            >(
              `SELECT p."id", p."sku", p."tracks_lots" AS "tracksLots", u."code" AS "unitCode"
                 FROM "${schema}"."products" p
                 JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
                WHERE lower(p."sku") = ANY($1::text[])`,
              skus,
            ),
        tx.movementType.findMany({
          where: { isBase: true, name: { in: typeNames } },
          select: { id: true, name: true, countsAsDemand: true },
        }),
        // Roles that grant the import permission, with their movement types.
        tx.roleAssignment.findMany({
          where: {
            userId: auth.user.id,
            role: { permissions: { some: { permission: { code: IMPORT } } } },
          },
          select: {
            warehouseId: true,
            role: {
              select: { movementTypes: { select: { movementTypeId: true } } },
            },
          },
        }),
      ]);

    const warehouses = new Map<string, { id: number; code: string }>();
    for (const w of warehouseRows) {
      if (scope === 'ALL' || scope.includes(w.id)) {
        warehouses.set(lower(w.code), w);
      }
    }
    const warehouseIds = [...warehouses.values()].map((w) => w.id);
    const products = new Map(productRows.map((p) => [lower(p.sku), p]));

    const allowedTypes = new Map<number, Set<number>>();
    for (const wid of warehouseIds) allowedTypes.set(wid, new Set());
    for (const a of assignments) {
      const targets = a.warehouseId === null ? warehouseIds : [a.warehouseId];
      for (const wid of targets) {
        const set = allowedTypes.get(wid);
        if (set)
          for (const t of a.role.movementTypes) set.add(t.movementTypeId);
      }
    }

    const locationCodes = unique([
      lower(DEFAULT_LOCATION),
      ...rows.map((r) => r.locationCode && lower(r.locationCode)),
    ]);
    const productIds = [...products.values()].map((p) => p.id);
    const lotCodes = unique(rows.map((r) => r.lotCode && lower(r.lotCode)));
    const [locationRows, lotRows] = await Promise.all([
      warehouseIds.length === 0
        ? []
        : tx.$queryRawUnsafe<
            { id: number; warehouseId: number; code: string }[]
          >(
            `SELECT "id", "warehouse_id" AS "warehouseId", "code" FROM "${schema}"."locations"
              WHERE "warehouse_id" = ANY($1::int[]) AND lower("code") = ANY($2::text[])`,
            warehouseIds,
            locationCodes,
          ),
      productIds.length === 0 || lotCodes.length === 0
        ? []
        : tx.$queryRawUnsafe<{ id: number; productId: number; code: string }[]>(
            `SELECT "id", "product_id" AS "productId", "code" FROM "${schema}"."lots"
              WHERE "product_id" = ANY($1::int[]) AND lower("code") = ANY($2::text[])`,
            productIds,
            lotCodes,
          ),
    ]);

    return {
      warehouses,
      products,
      locations: new Map(
        locationRows.map((l) => [`${l.warehouseId}:${lower(l.code)}`, l.id]),
      ),
      lots: new Map(
        lotRows.map((l) => [`${l.productId}:${lower(l.code)}`, l.id]),
      ),
      types: new Map(typeRows.map((t) => [t.name, t])),
      allowedTypes,
    };
  }

  /**
   * The import, if the user may read it: they started it, or they may import in
   * every warehouse its rows resolved to. Otherwise it does not exist for them.
   */
  private async readable(auth: AuthContext, id: number): Promise<ImportRecord> {
    const tenant = this.tenant(auth);
    const record = await tenant.movementImport.findUnique({ where: { id } });
    if (!record) throw movementImportErrors.notFound();
    if (record.uploadedById === auth.user.id) return record;
    const scope = warehousesWithPermission(auth.user.roles, IMPORT);
    if (scope === 'ALL') return record;
    const touched = await tenant.movementImportRow.findMany({
      where: { importId: id, warehouseId: { not: null } },
      distinct: ['warehouseId'],
      select: { warehouseId: true },
    });
    const allowed =
      touched.length > 0 &&
      touched.every((t) => scope.includes(t.warehouseId!));
    if (!allowed) throw movementImportErrors.notFound();
    return record;
  }

  async report(
    auth: AuthContext,
    id: number,
    query: ImportIssuesQueryDto,
  ): Promise<MovementImportReportDto> {
    const record = await this.readable(auth, id);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.MovementImportIssueWhereInput = {
      importId: id,
      ...(query.severity && { severity: query.severity }),
      ...(query.code && { code: query.code }),
    };
    const tenant = this.tenant(auth);
    const [total, items] = await Promise.all([
      tenant.movementImportIssue.count({ where }),
      tenant.movementImportIssue.findMany({
        where,
        orderBy: [
          { rowNumber: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          rowNumber: true,
          field: true,
          severity: true,
          code: true,
          message: true,
          value: true,
        },
      }),
    ]);
    return { import: toDto(record), issues: { items, total, page, pageSize } };
  }

  /** Per product and warehouse: valid rows, the file's closing balance and demand. */
  async balances(
    auth: AuthContext,
    id: number,
    query: PageQueryDto,
  ): Promise<ImportBalancePageDto> {
    await this.readable(auth, id);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const tenant = this.tenant(auth);
    const [[{ total }], found] = await Promise.all([
      tenant.$queryRawUnsafe<{ total: number }[]>(
        `SELECT COUNT(*)::int AS "total" FROM (
           SELECT DISTINCT "warehouse_id", "product_id"
             FROM "${schema}"."movement_import_rows"
            WHERE "import_id" = $1 AND "status" = 'VALID') p`,
        id,
      ),
      tenant.$queryRawUnsafe<
        {
          productId: number;
          sku: string;
          productName: string;
          unit: string;
          warehouseId: number;
          warehouseCode: string;
          warehouseName: string;
          rows: number;
          closing: string | null;
          demand: string;
        }[]
      >(
        `WITH v AS (
           SELECT "warehouse_id", "product_id", "business_date", "row_number",
                  "running_balance", "demand_quantity"
             FROM "${schema}"."movement_import_rows"
            WHERE "import_id" = $1 AND "status" = 'VALID'
         ), last AS (
           SELECT DISTINCT ON ("warehouse_id", "product_id")
                  "warehouse_id", "product_id", "running_balance"
             FROM v
            ORDER BY "warehouse_id", "product_id", "business_date" DESC, "row_number" DESC
         ), totals AS (
           SELECT "warehouse_id", "product_id", COUNT(*)::int AS "rows",
                  SUM("demand_quantity") AS "demand"
             FROM v GROUP BY 1, 2
         )
         SELECT p."id" AS "productId", p."sku", p."name" AS "productName", u."code" AS "unit",
                w."id" AS "warehouseId", w."code" AS "warehouseCode", w."name" AS "warehouseName",
                t."rows", l."running_balance"::text AS "closing", t."demand"::text AS "demand"
           FROM totals t
           JOIN last l USING ("warehouse_id", "product_id")
           JOIN "${schema}"."products" p ON p."id" = t."product_id"
           JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
           JOIN "${schema}"."warehouses" w ON w."id" = t."warehouse_id"
          ORDER BY w."code", p."sku"
          LIMIT $2 OFFSET $3`,
        id,
        pageSize,
        (page - 1) * pageSize,
      ),
    ]);
    return {
      items: found.map((r) => ({
        product: {
          id: r.productId,
          sku: r.sku,
          name: r.productName,
          unit: r.unit,
        },
        warehouse: {
          id: r.warehouseId,
          code: r.warehouseCode,
          name: r.warehouseName,
        },
        rows: r.rows,
        closing: num(r.closing),
        demand: Number(r.demand),
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * The imported history of the warehouses where the user may read movements,
   * newest first; never mixed with Pango's movements.
   */
  async history(
    auth: AuthContext,
    query: HistoricalMovementsQueryDto,
  ): Promise<HistoricalMovementPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const empty = { items: [], total: 0, page, pageSize };
    const visible = warehousesWithPermission(auth.user.roles, READ);
    let warehouseIds = visible === 'ALL' ? null : visible;
    if (query.warehouseId !== undefined) {
      if (warehouseIds && !warehouseIds.includes(query.warehouseId)) {
        return empty;
      }
      warehouseIds = [query.warehouseId];
    }
    if (warehouseIds?.length === 0) return empty;

    const schema = assertTenantSchema(auth.organization.schemaName);
    const tenant = this.tenant(auth);
    const settings = await tenant.settings.findUnique({ where: { id: 1 } });
    const filters = [
      warehouseIds,
      query.productId ?? null,
      query.from ?? null,
      query.to ?? null,
      query.movementType ?? null,
      query.importId ?? null,
    ];
    const where = `
      WHERE ($1::int[] IS NULL OR h."warehouse_id" = ANY($1::int[]))
        AND ($2::int IS NULL OR h."product_id" = $2)
        AND ($3::date IS NULL OR h."business_date" >= $3::date)
        AND ($4::date IS NULL OR h."business_date" <= $4::date)
        AND ($5::text IS NULL OR h."movement_code" = $5)
        AND ($6::int IS NULL OR h."import_id" = $6)`;
    const start = pangoStartSql(
      schema,
      '$7',
      `l."product_id" IN (SELECT DISTINCT "product_id" FROM "${schema}"."historical_movements")`,
    );
    const [[{ total }], rows] = await Promise.all([
      tenant.$queryRawUnsafe<{ total: number }[]>(
        `SELECT COUNT(*)::int AS "total" FROM "${schema}"."historical_movements" h ${where}`,
        ...filters,
      ),
      tenant.$queryRawUnsafe<
        {
          id: number;
          date: string;
          movementType: string;
          productId: number;
          sku: string;
          productName: string;
          unit: string;
          warehouseId: number;
          warehouseCode: string;
          warehouseName: string;
          quantityIn: string | null;
          quantityOut: string | null;
          balance: string | null;
          documentRef: string | null;
          locationCode: string | null;
          lotCode: string | null;
          unitCost: string | null;
          afterCutover: boolean;
          importId: number;
          sourceNamespace: string;
          externalMovementId: string;
          lineNumber: number;
        }[]
      >(
        `SELECT h."id", to_char(h."business_date", 'YYYY-MM-DD') AS "date",
                h."movement_code" AS "movementType",
                p."id" AS "productId", p."sku", p."name" AS "productName", u."code" AS "unit",
                w."id" AS "warehouseId", w."code" AS "warehouseCode", w."name" AS "warehouseName",
                h."quantity_in"::text AS "quantityIn", h."quantity_out"::text AS "quantityOut",
                h."running_balance"::text AS "balance", h."document_ref" AS "documentRef",
                h."location_code" AS "locationCode", h."lot_code" AS "lotCode",
                h."unit_cost"::text AS "unitCost", NOT ${beforeCutover} AS "afterCutover",
                h."import_id" AS "importId", h."source_namespace" AS "sourceNamespace",
                h."external_movement_id" AS "externalMovementId", h."line_number" AS "lineNumber"
           FROM "${schema}"."historical_movements" h
           JOIN "${schema}"."products" p ON p."id" = h."product_id"
           JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
           JOIN "${schema}"."warehouses" w ON w."id" = h."warehouse_id"
           LEFT JOIN (${start}) s
             ON s."product_id" = h."product_id" AND s."warehouse_id" = h."warehouse_id"
           ${where}
          ORDER BY h."business_date" DESC, h."id" DESC
          LIMIT $8 OFFSET $9`,
        ...filters,
        settings?.timeZone ?? 'America/Bogota',
        pageSize,
        (page - 1) * pageSize,
      ),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        date: r.date,
        movementType: r.movementType,
        product: {
          id: r.productId,
          sku: r.sku,
          name: r.productName,
          unit: r.unit,
        },
        warehouse: {
          id: r.warehouseId,
          code: r.warehouseCode,
          name: r.warehouseName,
        },
        quantityIn: num(r.quantityIn),
        quantityOut: num(r.quantityOut),
        balance: num(r.balance),
        documentRef: r.documentRef,
        locationCode: r.locationCode,
        lotCode: r.lotCode,
        unitCost: num(r.unitCost),
        afterCutover: r.afterCutover,
        source: {
          importId: r.importId,
          sourceNamespace: r.sourceNamespace,
          externalMovementId: r.externalMovementId,
          lineNumber: r.lineNumber,
        },
      })),
      total,
      page,
      pageSize,
    };
  }
}

/** A validated row as staged. */
function stagedRow(
  importId: number,
  r: ValidatedRow,
  source: Prisma.JsonValue,
): Prisma.MovementImportRowCreateManyInput {
  return {
    importId,
    rowNumber: r.rowNumber,
    status: r.status,
    source: source ?? {},
    externalMovementId: r.externalMovementId,
    lineNumber: r.lineNumber,
    leg: r.leg,
    movementCode: r.movementCode,
    movementTypeId: r.movementTypeId,
    businessDate: r.businessDate
      ? new Date(`${r.businessDate}T00:00:00Z`)
      : null,
    warehouseId: r.warehouseId,
    productId: r.productId,
    locationCode: r.warehouseId
      ? (r.locationCode ?? DEFAULT_LOCATION)
      : r.locationCode,
    lotCode: r.lotCode,
    quantityIn: r.quantityIn,
    quantityOut: r.quantityOut,
    balanceAfter: r.balanceAfter,
    runningBalance: r.runningBalance,
    demandQuantity: r.demandQuantity,
    unitCost: r.unitCost,
    documentRef: r.documentRef,
  };
}
