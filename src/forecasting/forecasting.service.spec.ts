import type { HttpException } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import type { ControlPrismaService } from '../prisma/control-prisma.service.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import type { ForecastSeriesResult } from './contract.js';
import {
  type ForecastClient,
  ForecastServiceError,
} from './forecast-client.js';
import { buildSeries } from './forecast-input.js';
import { ForecastingService, toForecastRow } from './forecasting.service.js';

const auth = {
  account: { id: 1 },
  organization: { schemaName: 'tenant_demo' },
  user: {
    id: 1,
    roles: [
      {
        id: 1,
        name: 'Owner',
        isSystem: true,
        warehouse: null,
        permissions: ['forecast.run', 'forecast.read'],
      },
    ],
  },
} as unknown as AuthContext;

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

const okResult: ForecastSeriesResult = {
  series_id: 9,
  status: 'ok',
  model_name: 'naive',
  model_version: 'development',
  periods: [
    { period_start: '2026-11-16', estimate: 3, lower: 0, upper: 6 },
    { period_start: '2026-11-23', estimate: 3, lower: 0, upper: 6 },
  ],
  total: { estimate: 6, lower: 0, upper: 12 },
  warnings: ['note'],
  error: null,
  profile: { demand_class: 'SMOOTH', history_class: 'LIMITED' },
  horizon_business_days: [5.6, 5.6],
};

describe('toForecastRow', () => {
  it('keeps an ok result with its model, profile and periods', () => {
    expect(toForecastRow(9, okResult)).toMatchObject({
      status: 'OK',
      modelName: 'naive',
      demandClass: 'SMOOTH',
      total: { estimate: 6, lower: 0, upper: 12 },
      periods: [
        { periodStart: '2026-11-16', estimate: 3, lower: 0, upper: 6 },
        { periodStart: '2026-11-23', estimate: 3, lower: 0, upper: 6 },
      ],
      horizonBusinessDays: [5.6, 5.6],
      errorCode: null,
    });
  });

  it('stores per-series errors, keeping the profile', () => {
    expect(
      toForecastRow(9, {
        series_id: 9,
        status: 'error',
        periods: [],
        error: { code: 'INSUFFICIENT_HISTORY', message: 'Not enough' },
        profile: { demand_class: 'INSUFFICIENT' },
      }),
    ).toMatchObject({
      status: 'ERROR',
      errorCode: 'INSUFFICIENT_HISTORY',
      demandClass: 'INSUFFICIENT',
      periods: [],
    });
  });

  it('keeps a declined series as a decision with its reason', () => {
    expect(
      toForecastRow(9, {
        series_id: 9,
        status: 'no_forecast',
        reason: 'non_stock_warehouse',
        periods: [],
        error: null,
      }),
    ).toMatchObject({
      status: 'NO_FORECAST',
      reason: 'non_stock_warehouse',
      errorCode: null,
    });
  });

  it('turns missing and malformed results into errors', () => {
    expect(toForecastRow(9, undefined).errorCode).toBe('MISSING_RESULT');
    expect(
      toForecastRow(9, {
        ...okResult,
        periods: [
          { period_start: '2026-11-16', estimate: 3, lower: 4, upper: 6 },
        ],
      }).errorCode,
    ).toBe('INVALID_RESPONSE');
    // Unknown demand classes are not stored as such.
    expect(
      toForecastRow(9, { ...okResult, profile: { demand_class: 'WEIRD' } })
        .demandClass,
    ).toBeNull();
  });
});

describe('buildSeries', () => {
  it('groups demand and stock per product-warehouse and drops empty series', async () => {
    const tenant = {
      $queryRawUnsafe: vi.fn((sql: string) =>
        Promise.resolve(
          sql.includes('WITH daily')
            ? [
                { pw: 9, date: '2026-10-01', closing: '12' },
                { pw: 9, date: '2026-10-05', closing: '-2' },
              ]
            : [{ pw: 9, date: '2026-10-05', quantity: '14' }],
        ),
      ),
    };
    const series = await buildSeries(tenant as never, 'tenant_demo', {
      productWarehouses: [
        { id: 9, productId: 5, warehouseId: 1 },
        { id: 10, productId: 6, warehouseId: 1 },
      ],
      historyEnd: '2026-11-15',
      timeZone: 'America/Bogota',
      stockRequestTypeId: 3,
    });
    expect(series).toEqual([
      {
        series_id: 9,
        product_id: 5,
        warehouse_id: 1,
        metadata: {},
        demand: [{ date: '2026-10-05', quantity: 14 }],
        // Negative stock is sent as a stockout.
        stock: [
          { date: '2026-10-01', closing_stock: 12 },
          { date: '2026-10-05', closing_stock: 0 },
        ],
      },
    ]);
    // Demand uses the shared rule, with the stock request type and the cut-off.
    expect(tenant.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('t."counts_as_demand"'),
      [9, 10],
      'America/Bogota',
      '2026-11-15',
      3,
    );
  });
});

function setup(configured = true) {
  const tenant = {
    warehouse: { findUnique: vi.fn().mockResolvedValue({ isActive: true }) },
    product: {
      findUnique: vi.fn().mockResolvedValue({ isActive: true, id: 5 }),
    },
    settings: {
      findUnique: vi.fn().mockResolvedValue({
        timeZone: 'America/Bogota',
        stockRequestMovementTypeId: 3,
      }),
    },
    productWarehouse: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 9,
          productId: 5,
          warehouseId: 1,
          leadTimeDays: 7,
          product: {
            sku: 'TOR-001',
            category: { name: 'Hardware' },
            stockUnit: { code: 'EA' },
          },
          warehouse: { code: 'NORTH', type: 'WAREHOUSE', holdsStock: true },
        },
      ]),
    },
    forecastRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    forecast: {
      updateMany: vi.fn(),
      createManyAndReturn: vi.fn().mockResolvedValue([
        { id: 70, productWarehouseId: 9 },
        { id: 71, productWarehouseId: 10 },
      ]),
    },
    forecastPeriod: { createMany: vi.fn() },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  tenant.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn(tenant),
  );
  const client = {
    configured,
    horizon: 4,
    maxSeries: 1,
    forecast: vi.fn(),
  };
  const service = new ForecastingService(
    {
      account: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as ControlPrismaService,
    { client: () => tenant } as unknown as TenantPrismaService,
    client as unknown as ForecastClient,
  );
  return { tenant, client, service };
}

const run = {
  id: 41,
  requestId: 'req',
  horizon: 4,
  historyEnd: new Date('2026-11-15T00:00:00Z'),
};
const seriesOf = (id: number) => ({
  series_id: id,
  product_id: 5,
  warehouse_id: 1,
  metadata: {},
  demand: [{ date: '2026-10-05', quantity: 1 }],
  stock: [],
});

describe('ForecastingService.start', () => {
  it('needs the service configured, and no run in progress', async () => {
    expect(await errorCode(setup(false).service.start(auth, {}))).toBe(
      'FORECAST_SERVICE_NOT_CONFIGURED',
    );
    const { tenant, service } = setup();
    tenant.forecastRun.findFirst.mockResolvedValue({
      id: 1,
      startedAt: new Date(),
    });
    expect(await errorCode(service.start(auth, {}))).toBe(
      'FORECAST_RUN_IN_PROGRESS',
    );
  });

  it('refuses when no series has history', async () => {
    const { tenant, service } = setup();
    expect(await errorCode(service.start(auth, {}))).toBe(
      'NOTHING_TO_FORECAST',
    );
    expect(tenant.forecastRun.create).not.toHaveBeenCalled();
  });
});

describe('ForecastingService.execute', () => {
  it('sends batches and stores every result, marking the OK ones current', async () => {
    const { tenant, client, service } = setup();
    client.forecast
      .mockResolvedValueOnce({
        policy_version: 'development-1',
        service_version: '0.1.0',
        results: [okResult],
      })
      .mockResolvedValueOnce({
        results: [
          {
            series_id: 10,
            status: 'error',
            periods: [],
            error: { code: 'INSUFFICIENT_HISTORY', message: 'x' },
          },
        ],
      });

    await service.execute(
      tenant as never,
      run,
      [seriesOf(9), seriesOf(10)],
      [{ warehouse_id: 1, holds_stock: true }],
    );

    expect(client.forecast).toHaveBeenCalledTimes(2);
    expect(client.forecast.mock.calls[0][0]).toMatchObject({
      contract_version: '1.2',
      request_id: 'req-1',
      forecast_run_id: 41,
      frequency: 'WEEKLY',
      horizon: 4,
      history_end: '2026-11-15',
      warehouses: [{ warehouse_id: 1, holds_stock: true }],
    });
    expect(tenant.forecast.updateMany).toHaveBeenCalledWith({
      where: { productWarehouseId: { in: [9] }, isCurrent: true },
      data: { isCurrent: false },
    });
    const rows = tenant.forecast.createManyAndReturn.mock.calls[0][0].data;
    expect(
      rows.map((r: { status: string; isCurrent: boolean }) => [
        r.status,
        r.isCurrent,
      ]),
    ).toEqual([
      ['OK', true],
      ['ERROR', false],
    ]);
    expect(tenant.forecastPeriod.createMany.mock.calls[0][0].data).toHaveLength(
      2,
    );
    expect(tenant.forecastRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: 'PARTIAL',
        seriesOk: 1,
        seriesError: 1,
        seriesNoForecast: 0,
        policyVersion: 'development-1',
      }),
    });
  });

  it('completes a run whose series were forecast or declined', async () => {
    const { tenant, client, service } = setup();
    client.forecast
      .mockResolvedValueOnce({ results: [okResult] })
      .mockResolvedValueOnce({
        results: [
          {
            series_id: 10,
            status: 'no_forecast',
            reason: 'inactive',
            periods: [],
          },
        ],
      });

    await service.execute(
      tenant as never,
      run,
      [seriesOf(9), seriesOf(10)],
      [{ warehouse_id: 1, holds_stock: true }],
    );

    // A decision not to forecast also supersedes the current forecast.
    expect(tenant.forecast.updateMany).toHaveBeenCalledWith({
      where: { productWarehouseId: { in: [9, 10] }, isCurrent: true },
      data: { isCurrent: false },
    });
    const rows = tenant.forecast.createManyAndReturn.mock.calls[0][0].data;
    expect(rows[1]).toMatchObject({
      status: 'NO_FORECAST',
      reason: 'inactive',
      isCurrent: false,
    });
    expect(tenant.forecastRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: 'COMPLETED',
        seriesOk: 1,
        seriesError: 0,
        seriesNoForecast: 1,
      }),
    });
  });

  it('fails the run and stores nothing when a call fails', async () => {
    const { tenant, client, service } = setup();
    client.forecast
      .mockResolvedValueOnce({ results: [okResult] })
      .mockRejectedValueOnce(new ForecastServiceError('answered 503'));

    await service.execute(
      tenant as never,
      run,
      [seriesOf(9), seriesOf(10)],
      [{ warehouse_id: 1, holds_stock: true }],
    );

    expect(tenant.forecast.createManyAndReturn).not.toHaveBeenCalled();
    expect(tenant.forecastRun.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'answered 503',
      }),
    });
  });
});
