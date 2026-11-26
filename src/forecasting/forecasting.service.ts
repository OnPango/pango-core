import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { lastCompleteSunday } from '../demand/demand.service.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import type { DemandClass } from '../generated/prisma/tenant/enums.js';
import { ControlPrismaService } from '../prisma/control-prisma.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  evaluateAlerts,
  lockAlertScope,
} from '../replenishment/evaluate-alerts.js';
import { refreshReorderPoints } from '../replenishment/reorder-point.js';
import {
  CONTRACT_VERSION,
  type ForecastRequest,
  type ForecastSeriesInput,
  type ForecastSeriesResult,
} from './contract.js';
import { forecastErrors } from './forecast-errors.js';
import { ForecastClient } from './forecast-client.js';
import { buildSeries } from './forecast-input.js';
import type {
  PageQueryDto,
  ProductForecastsQueryDto,
  StartForecastRunDto,
} from './dto.js';
import type {
  ForecastDto,
  ForecastPageDto,
  ForecastRunDto,
  ForecastRunPageDto,
} from './responses.js';

type Tx = Prisma.TransactionClient;

/** A RUNNING run older than this was interrupted (e.g. by a restart). */
const STALE_RUN_MS = 60 * 60 * 1000;

const DEMAND_CLASSES = new Set<string>([
  'SMOOTH',
  'INTERMITTENT',
  'ERRATIC',
  'LUMPY',
  'INSUFFICIENT',
  'NOT_CLASSIFIABLE',
]);

const day = (date: Date) => date.toISOString().slice(0, 10);

/** One `forecasts` row (and its periods) from a series result of the service. */
export interface ForecastRow {
  productWarehouseId: number;
  status: 'OK' | 'ERROR' | 'NO_FORECAST';
  /** Why the service declined the series (NO_FORECAST). */
  reason: string | null;
  modelName: string | null;
  modelVersion: string | null;
  demandClass: DemandClass | null;
  total: { estimate: number; lower: number; upper: number } | null;
  periods: {
    periodStart: string;
    estimate: number;
    lower: number;
    upper: number;
  }[];
  profile: Record<string, unknown> | null;
  warnings: string[];
  horizonBusinessDays: number[];
  errorCode: string | null;
  errorMessage: string | null;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const validInterval = (i: { estimate: number; lower: number; upper: number }) =>
  isNumber(i.estimate) &&
  isNumber(i.lower) &&
  isNumber(i.upper) &&
  i.lower >= 0 &&
  i.lower <= i.estimate &&
  i.estimate <= i.upper;

/**
 * Reads a series result: `ok` → OK, `no_forecast` → NO_FORECAST with its reason
 * (a decision, not a failure), `error` → ERROR. A missing result, or an `ok` one whose periods are
 * malformed (lower ≤ estimate ≤ upper, non-negative), is stored as an ERROR, so
 * one bad series never fails the whole run.
 */
export function toForecastRow(
  productWarehouseId: number,
  result: ForecastSeriesResult | undefined,
): ForecastRow {
  const base: ForecastRow = {
    productWarehouseId,
    status: 'ERROR',
    reason: null,
    modelName: null,
    modelVersion: null,
    demandClass: null,
    total: null,
    periods: [],
    profile: null,
    warnings: [],
    horizonBusinessDays: [],
    errorCode: null,
    errorMessage: null,
  };
  if (!result) {
    return {
      ...base,
      errorCode: 'MISSING_RESULT',
      errorMessage:
        'The forecasting service returned no result for this series',
    };
  }
  const demandClass = result.profile?.demand_class;
  const described = {
    ...base,
    demandClass:
      typeof demandClass === 'string' && DEMAND_CLASSES.has(demandClass)
        ? (demandClass as DemandClass)
        : null,
    profile: result.profile ?? null,
    warnings: (result.warnings ?? []).filter((w) => typeof w === 'string'),
    horizonBusinessDays: (result.horizon_business_days ?? []).filter(isNumber),
  };
  if (result.status === 'no_forecast') {
    return {
      ...described,
      status: 'NO_FORECAST',
      reason: result.reason?.slice(0, 40) ?? null,
    };
  }
  if (result.status !== 'ok') {
    return {
      ...described,
      errorCode: result.error?.code?.slice(0, 40) ?? 'UNKNOWN',
      errorMessage: result.error?.message ?? null,
    };
  }
  const periods = result.periods ?? [];
  const valid =
    periods.length > 0 &&
    periods.every(
      (p) => /^\d{4}-\d{2}-\d{2}$/.test(p.period_start) && validInterval(p),
    ) &&
    (!result.total || validInterval(result.total));
  if (!valid) {
    return {
      ...described,
      errorCode: 'INVALID_RESPONSE',
      errorMessage: 'The forecast periods are malformed',
    };
  }
  return {
    ...described,
    status: 'OK',
    modelName: result.model_name?.slice(0, 60) ?? null,
    modelVersion: result.model_version?.slice(0, 60) ?? null,
    total: result.total ?? null,
    periods: periods.map((p) => ({
      periodStart: p.period_start,
      estimate: p.estimate,
      lower: p.lower,
      upper: p.upper,
    })),
  };
}

const runInclude = {
  startedBy: { select: { id: true, accountId: true } },
} satisfies Prisma.ForecastRunInclude;
type RunWithRefs = Prisma.ForecastRunGetPayload<{ include: typeof runInclude }>;

const forecastInclude = {
  run: { select: { historyEnd: true } },
  productWarehouse: {
    select: { warehouse: { select: { id: true, name: true } } },
  },
  periods: { orderBy: { periodStart: 'asc' } },
} satisfies Prisma.ForecastInclude;
type ForecastWithRefs = Prisma.ForecastGetPayload<{
  include: typeof forecastInclude;
}>;

function toForecastDto(f: ForecastWithRefs): ForecastDto {
  const n = (d: Prisma.Decimal) => d.toNumber();
  return {
    id: f.id,
    runId: f.runId,
    historyEnd: day(f.run.historyEnd),
    warehouse: f.productWarehouse.warehouse,
    status: f.status,
    reason: f.reason,
    modelName: f.modelName,
    modelVersion: f.modelVersion,
    demandClass: f.demandClass,
    total:
      f.totalEstimate && f.totalLower && f.totalUpper
        ? {
            estimate: n(f.totalEstimate),
            lower: n(f.totalLower),
            upper: n(f.totalUpper),
          }
        : null,
    periods: f.periods.map((p) => ({
      periodStart: day(p.periodStart),
      estimate: n(p.estimatedDemand),
      lower: n(p.lowerBound),
      upper: n(p.upperBound),
    })),
    profile: (f.profile as Record<string, unknown> | null) ?? null,
    warnings: (f.warnings as string[] | null) ?? [],
    horizonBusinessDays: (f.horizonBusinessDays as number[] | null) ?? [],
    error:
      f.errorCode === null
        ? null
        : { code: f.errorCode, message: f.errorMessage ?? '' },
    isCurrent: f.isCurrent,
    createdAt: f.createdAt,
  };
}

// CU-10 (US-38, US-39): forecast runs through the forecasting service (contract
// v1.1). A run sends one series per active product-warehouse with history and
// stores every result, OK or ERROR. Previous forecasts are never overwritten
// (RF-PRED-004); the latest OK one per product-warehouse is `isCurrent`.
@Injectable()
export class ForecastingService {
  private readonly logger = new Logger(ForecastingService.name);

  constructor(
    private readonly control: ControlPrismaService,
    private readonly tenants: TenantPrismaService,
    private readonly client: ForecastClient,
  ) {}

  /** Starts a run; it continues in the background (poll `GET /forecast-runs/:id`). */
  async start(
    auth: AuthContext,
    dto: StartForecastRunDto,
  ): Promise<ForecastRunDto> {
    if (!this.client.configured) throw forecastErrors.notConfigured();
    const tenant = this.tenant(auth);
    const schema = assertTenantSchema(auth.organization.schemaName);

    if (dto.warehouseId !== undefined) {
      const warehouse = await tenant.warehouse.findUnique({
        where: { id: dto.warehouseId },
        select: { isActive: true },
      });
      if (!warehouse?.isActive) throw forecastErrors.warehouseNotFound();
    }
    if (dto.productId !== undefined) {
      const product = await tenant.product.findUnique({
        where: { id: dto.productId },
        select: { isActive: true },
      });
      if (!product?.isActive) throw forecastErrors.productNotFound();
    }
    await this.assertNoRunInProgress(tenant);

    const settings = await tenant.settings.findUnique({ where: { id: 1 } });
    const timeZone = settings?.timeZone ?? 'America/Bogota';
    const historyEnd = lastCompleteSunday(timeZone);
    const productWarehouses = await tenant.productWarehouse.findMany({
      where: {
        isActive: true,
        product: { isActive: true },
        warehouse: { isActive: true },
        ...(dto.warehouseId !== undefined && { warehouseId: dto.warehouseId }),
        ...(dto.productId !== undefined && { productId: dto.productId }),
      },
      select: {
        id: true,
        productId: true,
        warehouseId: true,
        leadTimeDays: true,
        product: {
          select: {
            sku: true,
            category: { select: { name: true } },
            stockUnit: { select: { code: true } },
          },
        },
        warehouse: { select: { code: true, type: true, holdsStock: true } },
      },
      orderBy: { id: 'asc' },
    });
    const series = await buildSeries(tenant, schema, {
      productWarehouses: productWarehouses.map((pw) => ({
        id: pw.id,
        productId: pw.productId,
        warehouseId: pw.warehouseId,
        metadata: {
          sku: pw.product.sku,
          category: pw.product.category.name,
          stock_unit: pw.product.stockUnit.code,
          warehouse_code: pw.warehouse.code,
          warehouse_type: pw.warehouse.type,
          lead_time_days: pw.leadTimeDays,
        },
      })),
      historyEnd,
      timeZone,
    });
    if (series.length === 0) throw forecastErrors.nothingToForecast();

    const run = await tenant.forecastRun.create({
      data: {
        requestId: randomUUID(),
        granularity: 'WEEKLY',
        horizon: this.client.horizon,
        historyEnd: new Date(`${historyEnd}T00:00:00Z`),
        startedById: auth.user.id,
        seriesTotal: series.length,
      },
      include: runInclude,
    });
    // Administrator-managed: whether each warehouse holds stock (contract 1.2).
    const holdsStock = new Map(
      productWarehouses.map((pw) => [pw.warehouseId, pw.warehouse.holdsStock]),
    );
    const warehouses = [...holdsStock].map(([warehouseId, holds]) => ({
      warehouse_id: warehouseId,
      holds_stock: holds,
    }));
    void this.execute(tenant, schema, run, series, warehouses);
    const [dto0] = await this.toRunDtos([run]);
    return dto0;
  }

  /**
   * Sends the series in batches and stores every result in one transaction. If
   * any call fails, the run is FAILED and nothing is stored (CU-10 E2). The run
   * ends COMPLETED, or PARTIAL when some series failed (ERROR); declined series
   * (NO_FORECAST) are decisions, not failures. In the same transaction, the
   * FORECAST_ROP product-warehouses get their reorder point recalculated from
   * the new current forecast (CU-11) and their alerts re-evaluated.
   */
  async execute(
    tenant: Tx & { $transaction: Prisma.TransactionClient['$transaction'] },
    schema: string,
    run: { id: number; requestId: string; horizon: number; historyEnd: Date },
    series: ForecastSeriesInput[],
    warehouses: ForecastRequest['warehouses'],
  ): Promise<void> {
    try {
      const results = new Map<number, ForecastSeriesResult>();
      let policyVersion: string | null = null;
      let serviceVersion: string | null = null;
      for (let i = 0; i < series.length; i += this.client.maxSeries) {
        const batch = series.slice(i, i + this.client.maxSeries);
        const response = await this.client.forecast({
          contract_version: CONTRACT_VERSION,
          request_id: `${run.requestId}-${i / this.client.maxSeries + 1}`,
          forecast_run_id: run.id,
          frequency: 'WEEKLY',
          horizon: run.horizon,
          history_end: day(run.historyEnd),
          warehouses,
          series: batch,
        });
        policyVersion = response.policy_version ?? policyVersion;
        serviceVersion = response.service_version ?? serviceVersion;
        for (const result of response.results ?? []) {
          results.set(Number(result.series_id), result);
        }
      }

      const rows = series.map((s) =>
        toForecastRow(s.series_id, results.get(s.series_id)),
      );
      const ok = rows.filter((r) => r.status === 'OK');
      const declined = rows.filter((r) => r.status === 'NO_FORECAST');
      const failed = rows.length - ok.length - declined.length;
      // A new OK forecast, or a decision not to forecast, supersedes the current
      // one; a failure keeps it.
      const superseded = [...ok, ...declined].map((r) => r.productWarehouseId);
      await tenant.$transaction(
        async (tx) => {
          await tx.forecast.updateMany({
            where: {
              productWarehouseId: { in: superseded },
              isCurrent: true,
            },
            data: { isCurrent: false },
          });
          const created = await tx.forecast.createManyAndReturn({
            data: rows.map((r) => ({
              runId: run.id,
              productWarehouseId: r.productWarehouseId,
              status: r.status,
              reason: r.reason,
              modelName: r.modelName,
              modelVersion: r.modelVersion,
              demandClass: r.demandClass,
              totalEstimate: r.total?.estimate ?? null,
              totalLower: r.total?.lower ?? null,
              totalUpper: r.total?.upper ?? null,
              profile: (r.profile ?? Prisma.DbNull) as Prisma.InputJsonValue,
              warnings: r.warnings,
              horizonBusinessDays: r.horizonBusinessDays,
              errorCode: r.errorCode,
              errorMessage: r.errorMessage,
              isCurrent: r.status === 'OK',
            })),
            select: { id: true, productWarehouseId: true },
          });
          const idOf = new Map(
            created.map((f) => [f.productWarehouseId, f.id]),
          );
          await tx.forecastPeriod.createMany({
            data: ok.flatMap((r) =>
              r.periods.map((p) => ({
                forecastId: idOf.get(r.productWarehouseId)!,
                periodStart: new Date(`${p.periodStart}T00:00:00Z`),
                estimatedDemand: p.estimate,
                lowerBound: p.lower,
                upperBound: p.upper,
              })),
            ),
          });
          await tx.forecastRun.update({
            where: { id: run.id },
            data: {
              status: failed > 0 ? 'PARTIAL' : 'COMPLETED',
              seriesOk: ok.length,
              seriesError: failed,
              seriesNoForecast: declined.length,
              policyVersion: policyVersion?.slice(0, 60) ?? null,
              serviceVersion: serviceVersion?.slice(0, 30) ?? null,
              finishedAt: new Date(),
            },
          });
          await this.recalculateReorderPoints(
            tx,
            schema,
            rows.map((r) => r.productWarehouseId),
          );
        },
        { timeout: 120_000 },
      );
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`forecast_run_id=${run.id} failed: ${message}`);
      await tenant.forecastRun
        .update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            errorMessage: message.slice(0, 2000),
            finishedAt: new Date(),
          },
        })
        .catch((e: Error) =>
          this.logger.error(`forecast_run_id=${run.id}: ${e.message}`),
        );
    }
  }

  /**
   * CU-11: recalculates the reorder point of the run's FORECAST_ROP
   * product-warehouses and re-evaluates their alerts. The products of every
   * series are locked first (in id order, as movements do), so the method, lead
   * time and current forecast are read under the lock: a concurrent PUT that
   * switches a row to FORECAST_ROP either commits first and is seen here, or
   * waits and then reads this run's forecast.
   */
  private async recalculateReorderPoints(
    tx: Tx,
    schema: string,
    productWarehouseIds: number[],
  ): Promise<void> {
    const locked = await lockAlertScope(tx, schema, {
      id: { in: productWarehouseIds },
    });
    if (locked.length === 0) return;
    const targets = await tx.productWarehouse.findMany({
      where: { id: { in: locked }, replenishmentMethod: 'FORECAST_ROP' },
      select: { id: true },
    });
    if (targets.length === 0) return;
    const ids = targets.map((pw) => pw.id);
    await refreshReorderPoints(tx, ids);
    await evaluateAlerts(tx, ids);
  }

  async listRuns(
    auth: AuthContext,
    query: PageQueryDto,
  ): Promise<ForecastRunPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const tenant = this.tenant(auth);
    const [total, runs] = await Promise.all([
      tenant.forecastRun.count(),
      tenant.forecastRun.findMany({
        include: runInclude,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.toRunDtos(runs), total, page, pageSize };
  }

  async getRun(auth: AuthContext, id: number): Promise<ForecastRunDto> {
    const run = await this.tenant(auth).forecastRun.findUnique({
      where: { id },
      include: runInclude,
    });
    if (!run) throw forecastErrors.runNotFound();
    const [dto] = await this.toRunDtos([run]);
    return dto;
  }

  /** Forecasts of a product, newest first, in the warehouses the user can read. */
  async productForecasts(
    auth: AuthContext,
    productId: number,
    query: ProductForecastsQueryDto,
  ): Promise<ForecastPageDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const tenant = this.tenant(auth);
    const product = await tenant.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw forecastErrors.productNotFound();

    let warehouseIds: number[] | null;
    if (query.warehouseId !== undefined) {
      if (
        !permissionsInWarehouse(auth.user.roles, query.warehouseId).has(
          'forecast.read',
        )
      ) {
        throw forecastErrors.warehouseNotFound();
      }
      warehouseIds = [query.warehouseId];
    } else {
      const readable = warehousesWithPermission(
        auth.user.roles,
        'forecast.read',
      );
      warehouseIds = readable === 'ALL' ? null : readable;
    }
    const where: Prisma.ForecastWhereInput = {
      productWarehouse: {
        productId,
        ...(warehouseIds && { warehouseId: { in: warehouseIds } }),
      },
    };
    const [total, forecasts] = await Promise.all([
      tenant.forecast.count({ where }),
      tenant.forecast.findMany({
        where,
        include: forecastInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: forecasts.map(toForecastDto), total, page, pageSize };
  }

  private tenant(auth: AuthContext) {
    return this.tenants.client(auth.organization.schemaName);
  }

  /** One run at a time; a RUNNING run older than an hour is marked FAILED. */
  private async assertNoRunInProgress(tenant: Tx) {
    const running = await tenant.forecastRun.findFirst({
      where: { status: 'RUNNING' },
      select: { id: true, startedAt: true },
    });
    if (!running) return;
    if (Date.now() - running.startedAt.getTime() < STALE_RUN_MS) {
      throw forecastErrors.runInProgress();
    }
    await tenant.forecastRun.update({
      where: { id: running.id },
      data: {
        status: 'FAILED',
        errorMessage: 'The run was interrupted',
        finishedAt: new Date(),
      },
    });
  }

  private async toRunDtos(runs: RunWithRefs[]): Promise<ForecastRunDto[]> {
    const accountIds = [
      ...new Set(
        runs.flatMap((r) => (r.startedBy ? [r.startedBy.accountId] : [])),
      ),
    ];
    const accounts =
      accountIds.length === 0
        ? []
        : await this.control.account.findMany({
            where: { id: { in: accountIds } },
            select: { id: true, name: true },
          });
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    return runs.map((run) => ({
      id: run.id,
      requestId: run.requestId,
      status: run.status,
      granularity: run.granularity,
      horizon: run.horizon,
      historyEnd: day(run.historyEnd),
      startedBy: run.startedBy && {
        id: run.startedBy.id,
        name: names.get(run.startedBy.accountId) ?? null,
      },
      seriesTotal: run.seriesTotal,
      seriesOk: run.seriesOk,
      seriesError: run.seriesError,
      seriesNoForecast: run.seriesNoForecast,
      policyVersion: run.policyVersion,
      serviceVersion: run.serviceVersion,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }));
  }
}
