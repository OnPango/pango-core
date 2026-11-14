-- "Sales issue": base outbound movement type for stock sold to customers (mostly
-- from STORE warehouses). It counts as demand: sales are the real demand of a
-- point of sale, like internal consumption is for a department.
INSERT INTO "movement_types" ("name", "nature", "counts_as_demand", "is_base")
VALUES ('Sales issue', 'OUTBOUND', true, true)
ON CONFLICT ("name") DO NOTHING;

-- Owner and Admin allow every movement type; Operator every base type.
INSERT INTO "role_movement_types" ("role_id", "movement_type_id")
SELECT r."id", t."id"
FROM "roles" r CROSS JOIN "movement_types" t
WHERE r."name" IN ('Owner', 'Admin', 'Operator') AND t."name" = 'Sales issue'
ON CONFLICT DO NOTHING;
