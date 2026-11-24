// Imported history (CU-17) is read only by demand, the forecast input and the
// history views. For each product and warehouse it counts only before the day
// that product started moving in Pango there, so nothing is counted twice and
// Pango's own record rules from then on. The cutover is computed when read: it
// moves if the first Pango movement is later than the import.

/**
 * SQL selecting, per product and warehouse, the local date of its first Pango
 * movement there (`"product_id"`, `"warehouse_id"`, `"day"`). A movement counts in
 * both warehouses of a transfer. `tz` is the SQL of the time zone parameter
 * (e.g. `$2`); `where` filters the lines `l` (e.g. by product).
 */
export function pangoStartSql(
  schema: string,
  tz: string,
  where = 'TRUE',
): string {
  return `SELECT l."product_id", loc."warehouse_id",
                 MIN((m."occurred_at" AT TIME ZONE ${tz})::date) AS "day"
            FROM "${schema}"."movement_lines" l
            JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
            JOIN "${schema}"."locations" loc
              ON loc."id" IN (l."origin_location_id", l."destination_location_id")
           WHERE ${where}
           GROUP BY 1, 2`;
}

/**
 * SQL condition: the historical line `h` is before the cutover `s` (a LEFT JOIN of
 * `pangoStartSql` on product and warehouse).
 */
export const beforeCutover = `(s."day" IS NULL OR h."business_date" < s."day")`;
