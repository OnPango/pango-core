// What counts as demand, shared by the demand history endpoint and the forecasting
// service input, so the chart and the model always read the same demand. Change it
// here only.

/**
 * SQL condition over a movement line's movement (`m`) and movement type (`t`):
 * CONFIRMED outbound movements whose type counts as demand. Sales and internal
 * consumption both count, whether or not the consumption fulfils a stock request
 * (US-013).
 */
export function demandCondition(): string {
  return `m."status" = 'CONFIRMED'
       AND t."nature" = 'OUTBOUND'
       AND t."counts_as_demand"`;
}
