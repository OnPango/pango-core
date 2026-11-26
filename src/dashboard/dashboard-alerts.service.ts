import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { localToday } from '../demand/demand.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import { loadSettings, localDayStart } from './dashboard-data.js';
import { inFilter, readableWarehouses } from './dashboard-scope.js';
import {
  ALERT_TREND_DEFAULT_MONTHS,
  type DashboardAlertsQueryDto,
} from './dto.js';
import type { AlertMonthDto, DashboardAlertsDto } from './responses.js';

/** `YYYY-MM` of the `count` months ending with the one of `today`, oldest first. */
export function lastMonths(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - (count - 1 - i), 1));
    return date.toISOString().slice(0, 7);
  });
}

// US-047, alerts tab: where the alerts in force are and how they evolve month by
// month. Needs `alert.read`, narrowed to the warehouses that grant it.
@Injectable()
export class DashboardAlertsService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async alerts(
    auth: AuthContext,
    query: DashboardAlertsQueryDto,
  ): Promise<DashboardAlertsDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const { timeZone } = await loadSettings(tenant);
    // The guard already required `alert.read`, so it is never false here.
    const readable = readableWarehouses(auth, 'alert.read', query.warehouseId);
    const warehouses = readable === false ? [] : readable;
    const months = lastMonths(
      localToday(timeZone),
      query.months ?? ALERT_TREND_DEFAULT_MONTHS,
    );

    const [bySeverity, monthly] = await Promise.all([
      tenant.$queryRawUnsafe<
        {
          warehouseId: number;
          warehouseName: string;
          critical: number;
          high: number;
          medium: number;
        }[]
      >(
        `SELECT w."id" AS "warehouseId", w."name" AS "warehouseName",
                COUNT(*) FILTER (WHERE a."severity" = 3)::int AS "critical",
                COUNT(*) FILTER (WHERE a."severity" = 2)::int AS "high",
                COUNT(*) FILTER (WHERE a."severity" <= 1)::int AS "medium"
           FROM "${schema}"."alerts" a
           JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
           JOIN "${schema}"."warehouses" w ON w."id" = pw."warehouse_id"
          WHERE a."status" IN ('OPEN', 'ATTENDED') AND ${inFilter('pw."warehouse_id"', 1)}
          GROUP BY w."id"
          ORDER BY COUNT(*) FILTER (WHERE a."severity" = 3) DESC, COUNT(*) DESC, w."name"`,
        warehouses,
      ),
      tenant.$queryRawUnsafe<
        {
          month: string;
          kind: keyof Omit<AlertMonthDto, 'month'>;
          total: number;
        }[]
      >(
        `WITH events AS (
           SELECT a."created_at" AS "at", 'created' AS "kind", pw."warehouse_id"
             FROM "${schema}"."alerts" a
             JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
           UNION ALL
           SELECT a."attended_at", 'attended', pw."warehouse_id"
             FROM "${schema}"."alerts" a
             JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
            WHERE a."attended_at" IS NOT NULL
           UNION ALL
           SELECT a."resolved_at", 'resolved', pw."warehouse_id"
             FROM "${schema}"."alerts" a
             JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
            WHERE a."resolved_at" IS NOT NULL
         )
         SELECT to_char("at" AT TIME ZONE $3, 'YYYY-MM') AS "month", "kind",
                COUNT(*)::int AS "total"
           FROM events
          WHERE "at" >= ${localDayStart(2, 3)} AND ${inFilter('"warehouse_id"', 1)}
          GROUP BY 1, 2`,
        warehouses,
        `${months[0]}-01`,
        timeZone,
      ),
    ]);

    const byMonth = new Map(
      months.map((month) => [
        month,
        { month, created: 0, attended: 0, resolved: 0 },
      ]),
    );
    for (const row of monthly) {
      const entry = byMonth.get(row.month);
      if (entry) entry[row.kind] = row.total;
    }
    return {
      bySeverity: bySeverity.map((r) => ({
        warehouse: { id: r.warehouseId, name: r.warehouseName },
        critical: r.critical,
        high: r.high,
        medium: r.medium,
      })),
      monthly: [...byMonth.values()],
    };
  }
}
