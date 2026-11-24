import { ApiProperty } from '@nestjs/swagger';
import { WarehouseRefDto } from '../auth/responses.js';
import { MovementProductDto } from '../movements/responses.js';

const nullable = (type: unknown, description: string) =>
  ApiProperty({ type: type as never, nullable: true, description });

// ─── Summary ──────────────────────────────────────────────────────────────────

export class TrendDto {
  @ApiProperty({ example: 248, description: 'Now' })
  current: number;

  @ApiProperty({ example: 230, description: 'One month earlier' })
  previous: number;
}

export class LowStockTrendDto extends TrendDto {
  @ApiProperty({
    example: 3,
    description: 'Products with an alert in force of severity 3',
  })
  critical: number;
}

export class RequestTrendDto extends TrendDto {
  @ApiProperty({ example: 4 })
  pending: number;

  @ApiProperty({ example: 2, description: 'Being attended (stock reserved)' })
  inProgress: number;
}

export class SummaryKpisDto {
  @nullable(
    TrendDto,
    'Active products (with a warehouse, active there); null without `catalog.read`',
  )
  products: TrendDto | null;

  @nullable(
    TrendDto,
    'On hand × average cost; a month ago, rebuilt from the movements since at today’s cost. Null without `stock.read`',
  )
  stockValue: TrendDto | null;

  @nullable(
    LowStockTrendDto,
    'Products with an alert in force (pending or attended), each counted once; null without `alert.read`',
  )
  lowStock: LowStockTrendDto | null;

  @nullable(
    RequestTrendDto,
    'Stock requests pending or being attended; null without `stock_request.read`',
  )
  pendingRequests: RequestTrendDto | null;
}

export class ReplenishItemDto {
  @ApiProperty({ example: 9 })
  alertId: number;

  @ApiProperty({ example: 3, description: '1 = lowest, 3 = nothing available' })
  severity: number;

  @ApiProperty({ enum: ['OPEN', 'ATTENDED'], enumName: 'AlertStatus' })
  status: 'OPEN' | 'ATTENDED';

  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 4, description: 'At the last evaluation' })
  available: number;

  @ApiProperty({ example: 20 })
  reorderPoint: number;

  @ApiProperty({ example: 46 })
  suggested: number;

  @nullable(
    Number,
    'Days the available stock lasts at the current forecast; null without one',
  )
  daysOfCover: number | null;
}

export class ReplenishBlockDto {
  @ApiProperty({ type: [ReplenishItemDto], description: 'Most severe first' })
  items: ReplenishItemDto[];

  @ApiProperty({ example: 12, description: 'Every alert in force' })
  total: number;
}

export class ActivityItemDto {
  @ApiProperty({ example: 41 })
  id: number;

  @ApiProperty({ example: 'MV-00000041' })
  number: string;

  @ApiProperty({
    enum: ['IN_TRANSIT', 'CONFIRMED', 'VOIDED'],
    enumName: 'MovementStatus',
  })
  status: string;

  @ApiProperty({ example: 'Entrada por compra', description: 'Movement type' })
  type: string;

  @ApiProperty({
    enum: ['INBOUND', 'OUTBOUND', 'TRANSFER', 'ADJUSTMENT'],
    enumName: 'MovementNature',
  })
  nature: string;

  @ApiProperty()
  occurredAt: Date;

  @ApiProperty({
    type: WarehouseRefDto,
    description: 'Where it happened; on transfers, the origin',
  })
  warehouse: WarehouseRefDto;

  @nullable(WarehouseRefDto, 'Transfers: where the stock goes')
  destinationWarehouse: WarehouseRefDto | null;

  @ApiProperty({ example: 'Tornillo M8', description: 'Product of line 1' })
  firstProduct: string;

  @ApiProperty({ example: 'TOR-001' })
  firstSku: string;

  @ApiProperty({ example: 3 })
  lineCount: number;

  @ApiProperty({ example: 'Ana Gómez', description: 'Who registered it' })
  registeredBy: string;
}

export class DashboardSummaryDto {
  @ApiProperty({ example: 'COP', description: 'Currency of every value' })
  currency: string;

  @ApiProperty({ description: 'The moment every `previous` refers to' })
  comparedTo: Date;

  @ApiProperty({ type: SummaryKpisDto })
  kpis: SummaryKpisDto;

  @nullable(
    ReplenishBlockDto,
    'Alerts in force, most severe first; null without `alert.read`',
  )
  lowStockItems: ReplenishBlockDto | null;

  @ApiProperty({
    type: [ActivityItemDto],
    nullable: true,
    description: 'Latest movements; null without `movement.read`',
  })
  recentActivity: ActivityItemDto[] | null;
}

// ─── Inventory level ─────────────────────────────────────────────────────────

export class LevelPointDto {
  @ApiProperty({
    example: '2026-11-17',
    description: 'First day of the period',
  })
  start: string;

  @ApiProperty({ example: '2026-11-17', description: 'Last day of the period' })
  end: string;

  @ApiProperty({
    example: 40,
    description:
      'Products with stock in some warehouse at the end of the period, those in low stock left out',
  })
  inStock: number;

  @nullable(
    Number,
    'Products with an alert in force in some warehouse at the end of the period; null without `alert.read`',
  )
  lowStock: number | null;
}

export class DashboardLevelDto {
  @ApiProperty({ example: 7 })
  days: number;

  @ApiProperty({ enum: ['DAY', 'WEEK'], enumName: 'LevelGranularity' })
  granularity: 'DAY' | 'WEEK';

  @ApiProperty({ type: [LevelPointDto], description: 'Oldest first' })
  points: LevelPointDto[];
}

// ─── Inventory ────────────────────────────────────────────────────────────────

export class FamilyValueDto {
  @ApiProperty({ example: 2, description: 'Top-level category' })
  familyId: number;

  @ApiProperty({ example: 'Ferretería' })
  name: string;

  @ApiProperty({ example: 1250000 })
  value: number;

  @ApiProperty({ example: 14, description: 'Product-warehouses with stock' })
  items: number;
}

export class InventoryValueDto {
  @ApiProperty({ example: 4800000 })
  total: number;

  @ApiProperty({ type: [FamilyValueDto], description: 'Highest value first' })
  byFamily: FamilyValueDto[];
}

export class ExcessItemDto {
  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 300 })
  available: number;

  @ApiProperty({ example: 120, description: 'What stock should not exceed' })
  limit: number;

  @ApiProperty({
    enum: ['MAX_STOCK', 'FORECAST'],
    enumName: 'ExcessLimitSource',
    description:
      'The max stock, or without one, 12 weeks of the current forecast',
  })
  limitSource: 'MAX_STOCK' | 'FORECAST';

  @ApiProperty({ example: 180, description: 'available − limit' })
  excess: number;

  @ApiProperty({ example: 270000, description: 'excess × average cost' })
  value: number;
}

export class ExcessBlockDto {
  @ApiProperty({ type: [ExcessItemDto], description: 'Highest value first' })
  items: ExcessItemDto[];

  @ApiProperty({ example: 6 })
  total: number;

  @ApiProperty({ example: 820000, description: 'Value of every excess' })
  value: number;
}

export class IdleItemDto {
  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 40 })
  onHand: number;

  @ApiProperty({ example: 160000 })
  value: number;

  @nullable(Date, 'Last time stock left the warehouse; null if it never did')
  lastOutboundAt: Date | null;
}

export class IdleBlockDto {
  @ApiProperty({ example: 90, description: 'Days without stock leaving' })
  days: number;

  @ApiProperty({ type: [IdleItemDto], description: 'Highest value first' })
  items: IdleItemDto[];

  @ApiProperty({ example: 9 })
  total: number;

  @ApiProperty({ example: 640000 })
  value: number;
}

export class ExpiringLotDto {
  @ApiProperty({ type: MovementProductDto })
  product: MovementProductDto;

  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 'L-2026-10' })
  lot: string;

  @ApiProperty({ example: '2026-12-01', description: 'Date only' })
  expiryDate: string;

  @ApiProperty({ example: 25 })
  onHand: number;

  @ApiProperty({ example: false, description: 'Already past its expiry' })
  expired: boolean;
}

export class ExpiringBlockDto {
  @ApiProperty({ example: 30, description: 'Days ahead that count' })
  days: number;

  @ApiProperty({
    type: [ExpiringLotDto],
    description: 'Earliest expiry first; expired ones included',
  })
  items: ExpiringLotDto[];

  @ApiProperty({ example: 3 })
  total: number;
}

export class DashboardInventoryDto {
  @ApiProperty({ example: 'COP' })
  currency: string;

  @ApiProperty({ type: InventoryValueDto })
  value: InventoryValueDto;

  @ApiProperty({ type: ExcessBlockDto })
  excess: ExcessBlockDto;

  @ApiProperty({ type: IdleBlockDto })
  idle: IdleBlockDto;

  @ApiProperty({ type: ExpiringBlockDto })
  expiringLots: ExpiringBlockDto;
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export class AlertsBySeverityDto {
  @ApiProperty({ type: WarehouseRefDto })
  warehouse: WarehouseRefDto;

  @ApiProperty({ example: 2, description: 'Severity 3' })
  critical: number;

  @ApiProperty({ example: 1, description: 'Severity 2' })
  high: number;

  @ApiProperty({ example: 4, description: 'Severity 1' })
  medium: number;
}

export class AlertMonthDto {
  @ApiProperty({ example: '2026-11', description: 'Local month' })
  month: string;

  @ApiProperty({ example: 9, description: 'Raised that month' })
  created: number;

  @ApiProperty({
    example: 4,
    description:
      'Marked attended that month and still marked (going back to pending clears it)',
  })
  attended: number;

  @ApiProperty({ example: 7, description: 'Resolved that month' })
  resolved: number;
}

export class DashboardAlertsDto {
  @ApiProperty({
    type: [AlertsBySeverityDto],
    description: 'Alerts in force (pending or attended) per warehouse',
  })
  bySeverity: AlertsBySeverityDto[];

  @ApiProperty({
    type: [AlertMonthDto],
    description: 'Oldest month first, every month present',
  })
  monthly: AlertMonthDto[];
}
