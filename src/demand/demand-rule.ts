// What counts as demand (RN-008, extended to sales), shared by the demand history
// endpoint and the forecasting service input, so the chart and the model always
// read the same demand. Change it here only.

/**
 * SQL condition over a movement line's movement (`m`) and movement type (`t`):
 * CONFIRMED outbound movements whose type counts as demand. Movements of the
 * stock request type count only when they fulfil a stock request.
 *
 * @param stockRequestTypeParam placeholder of `settings.stock_request_movement_type_id`, e.g. `$2`
 */
export function demandCondition(stockRequestTypeParam: string): string {
  return `m."status" = 'CONFIRMED'
       AND t."nature" = 'OUTBOUND'
       AND t."counts_as_demand"
       AND (m."stock_request_id" IS NOT NULL OR t."id" IS DISTINCT FROM ${stockRequestTypeParam}::int)`;
}
