-- Operator role: the second fixed role of the MVP (Owner = administrator).
-- Day-to-day operations on the catalog, warehouses, stock, movements, stock
-- requests, forecasts and alerts; no user, role or organization administration.
-- Not a system role, so it can be edited once roles become configurable.
INSERT INTO "roles" ("name", "description", "is_system")
VALUES ('Operator', 'Day-to-day inventory operations, without user or organization administration', false)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" = 'Operator'
  AND p."code" IN (
    'catalog.read',
    'product.manage',
    'category.manage',
    'supplier.manage',
    'warehouse.manage',
    'forecast.run',
    'warehouse.read',
    'location.manage',
    'stock.read',
    'replenishment.manage',
    'movement.read',
    'movement.create',
    'movement.confirm',
    'movement.receive',
    'movement.void',
    'stock_request.read',
    'stock_request.create',
    'stock_request.approve',
    'forecast.read',
    'alert.read',
    'alert.resolve'
  )
ON CONFLICT DO NOTHING;

INSERT INTO "role_movement_types" ("role_id", "movement_type_id")
SELECT r."id", t."id"
FROM "roles" r CROSS JOIN "movement_types" t
WHERE r."name" = 'Operator' AND t."is_base"
ON CONFLICT DO NOTHING;
