import type { HttpException } from '@nestjs/common';
import type { AuthContext, RoleGrant } from '../auth/auth-context.js';
import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import {
  DemandService,
  localToday,
  nextPeriod,
  periodStart,
  periodStarts,
} from './demand.service.js';
import { GranularityValue } from './dto.js';

const { WEEKLY, MONTHLY } = GranularityValue;
const north = { id: 1, name: 'North' };

function authWith(
  permissions: string[],
  warehouse: RoleGrant['warehouse'] = north,
): AuthContext {
  return {
    account: { id: 1, email: 'ana@demo.co', name: 'Ana' },
    organization: {
      id: 10,
      subdomain: 'demo',
      legalName: 'Demo SAS',
      schemaName: 'tenant_demo',
    },
    user: {
      id: 1,
      jobTitle: null,
      roles: [
        { id: 2, name: 'Clerk', isSystem: false, warehouse, permissions },
      ],
    },
  };
}
const reader = authWith(['forecast.read']);

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code: string }).code;
  }
  throw new Error('Expected the promise to reject');
}

function setup(
  first: string | null,
  rows: { period: string; quantity: string }[] = [],
) {
  const tenant = {
    warehouse: { findUnique: vi.fn().mockResolvedValue(north) },
    product: {
      findUnique: vi.fn().mockResolvedValue({
        id: 5,
        sku: 'TOR-001',
        name: 'Bolt',
        stockUnit: { code: 'EA' },
      }),
    },
    settings: {
      findUnique: vi.fn().mockResolvedValue({
        timeZone: 'America/Bogota',
        forecastGranularity: 'WEEKLY',
        stockRequestMovementTypeId: 3,
      }),
    },
    $queryRawUnsafe: vi.fn((sql: string, ..._params: unknown[]) =>
      Promise.resolve(sql.includes('MIN(') ? [{ first }] : rows),
    ),
  };
  const service = new DemandService({
    client: () => tenant,
  } as unknown as TenantPrismaService);
  return { tenant, service };
}

describe('demand periods', () => {
  it('snaps days to the start of their week (Monday) or month', () => {
    expect(periodStart('2026-11-14', WEEKLY)).toBe('2026-11-09'); // Saturday
    expect(periodStart('2026-11-09', WEEKLY)).toBe('2026-11-09'); // Monday
    expect(periodStart('2026-11-15', WEEKLY)).toBe('2026-11-09'); // Sunday
    expect(periodStart('2026-11-14', MONTHLY)).toBe('2026-11-01');
  });

  it('steps to the next period, across months and years', () => {
    expect(nextPeriod('2026-12-28', WEEKLY)).toBe('2027-01-04');
    expect(nextPeriod('2026-12-01', MONTHLY)).toBe('2027-01-01');
    expect(periodStarts('2026-10-01', '2026-12-01', MONTHLY)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
  });

  it('caps the number of periods', () => {
    expect(() => periodStarts('2000-01-03', '2026-11-09', WEEKLY)).toThrow();
  });

  it("gives today's date in the organization's time zone", () => {
    // 03:00 UTC is still the previous day in Bogotá (UTC−5).
    expect(localToday('America/Bogota', new Date('2026-11-15T03:00:00Z'))).toBe(
      '2026-11-14',
    );
  });
});

describe('DemandService.series', () => {
  it('fills the periods without demand with zeros', async () => {
    const { tenant, service } = setup('2026-10-21', [
      { period: '2026-10-19', quantity: '12' },
      { period: '2026-11-02', quantity: '30.5' },
    ]);
    const series = await service.series(reader, 5, {
      warehouseId: 1,
      to: '2026-11-04',
    });
    expect(series).toMatchObject({
      warehouse: north,
      granularity: 'WEEKLY',
      from: '2026-10-19',
      to: '2026-11-08',
      total: 42.5,
      notice: null,
      periods: [
        { periodStart: '2026-10-19', quantity: 12 },
        { periodStart: '2026-10-26', quantity: 0 },
        { periodStart: '2026-11-02', quantity: 30.5 },
      ],
    });
    // Product, stock request type, warehouses, time zone, period, range.
    expect(tenant.$queryRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('date_trunc($5'),
      5,
      3,
      [1],
      'America/Bogota',
      'week',
      '2026-10-19',
      '2026-11-09',
    );
  });

  it('counts stock request types only when they fulfil a request', async () => {
    const { tenant, service } = setup(null);
    await service.series(reader, 5, {});
    expect(tenant.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(
        '(m."stock_request_id" IS NOT NULL OR t."id" IS DISTINCT FROM $2::int)',
      ),
      5,
      3,
      [1],
      'America/Bogota',
    );
  });

  it('answers an empty series with a notice for a product without demand', async () => {
    const { service } = setup(null);
    expect(await service.series(reader, 5, {})).toMatchObject({
      from: null,
      periods: [],
      total: 0,
      notice: 'NO_HISTORY',
    });
  });

  it('uses every warehouse for the Owner and none without forecast.read there', async () => {
    const owner = authWith(['forecast.read'], null);
    const { tenant, service } = setup(null);
    await service.series(owner, 5, {});
    expect(tenant.$queryRawUnsafe.mock.calls[0][3]).toBeNull();

    expect(await errorCode(service.series(reader, 5, { warehouseId: 2 }))).toBe(
      'WAREHOUSE_NOT_FOUND',
    );
  });

  it('rejects a reversed range', async () => {
    const { service } = setup('2026-01-05');
    expect(
      await errorCode(
        service.series(reader, 5, { from: '2026-11-01', to: '2026-10-01' }),
      ),
    ).toBe('RANGE_INVALID');
  });
});
