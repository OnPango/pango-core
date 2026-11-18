// Forecasting service contract v1.2 (HTTP + JSON, snake_case). Pango Core sends
// normalized daily demand and stock; the service builds the weekly series and
// returns the forecast. Only the fields Core reads or sends are typed.

/** 1.2 is the only version answered with the `no_forecast` status. */
export const CONTRACT_VERSION = '1.2';

export interface DemandObservation {
  /** Local day, YYYY-MM-DD; only days with demand, never after history_end. */
  date: string;
  /** Gross demand of the day, never negative. */
  quantity: number;
}

export interface StockObservation {
  /** Local day, YYYY-MM-DD; only days the stock changed, never after history_end. */
  date: string;
  closing_stock: number;
}

export interface ForecastSeriesInput {
  /** product_warehouses.id */
  series_id: number;
  product_id: number;
  warehouse_id: number;
  /** Free-form, for traceability (never `made_to_order`, which is refused). */
  metadata: Record<string, string | number | null>;
  demand: DemandObservation[];
  stock: StockObservation[];
}

export interface ForecastRequest {
  contract_version: string;
  request_id: string;
  forecast_run_id: number;
  frequency: 'WEEKLY';
  horizon: number;
  /** The last complete Sunday. */
  history_end: string;
  /** Administrator-managed: series of a warehouse that holds no stock are declined. */
  warehouses: { warehouse_id: number; holds_stock: boolean }[];
  series: ForecastSeriesInput[];
}

export interface ForecastInterval {
  estimate: number;
  lower: number;
  upper: number;
}

export interface ForecastPeriodResult extends ForecastInterval {
  period_start: string;
}

export interface ForecastSeriesResult {
  series_id: number;
  /** `no_forecast`: declined on purpose, with a `reason`. */
  status: 'ok' | 'error' | 'no_forecast';
  reason?: string | null;
  model_name?: string | null;
  model_version?: string | null;
  periods: ForecastPeriodResult[];
  total?: ForecastInterval | null;
  warnings?: string[];
  error?: { code: string; message: string } | null;
  profile?: ({ demand_class?: string | null } & Record<string, unknown>) | null;
  horizon_business_days?: number[];
}

export interface ForecastResponse {
  contract_version: string;
  service_version?: string;
  policy_version?: string;
  request_id: string;
  forecast_run_id: number;
  results: ForecastSeriesResult[];
}
