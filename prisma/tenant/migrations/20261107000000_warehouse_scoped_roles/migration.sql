-- Warehouse-scoped administration:
-- - Only the Owner (a system role) applies to every warehouse; every other role is
--   assigned on a warehouse.
-- - Managing users is a warehouse-scope permission: an admin manages the users of
--   their warehouse.
-- - An Admin role with broad defaults; the Owner can change the permissions of
--   every non-system role.

-- Users are managed per warehouse.
UPDATE "permissions" SET "scope" = 'WAREHOUSE' WHERE "code" IN ('user.read', 'user.manage');

-- Admin role: everything except managing roles and organization settings.
INSERT INTO "roles" ("name", "description", "is_system")
VALUES ('Admin', 'Manages the users and operations of their warehouse', false)
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" = 'Admin' AND p."code" NOT IN ('role.manage', 'settings.manage')
ON CONFLICT DO NOTHING;

INSERT INTO "role_movement_types" ("role_id", "movement_type_id")
SELECT r."id", t."id"
FROM "roles" r CROSS JOIN "movement_types" t
WHERE r."name" = 'Admin'
ON CONFLICT DO NOTHING;

-- Non-system roles assigned on every warehouse become one assignment per active
-- warehouse (none is left if the organization has no warehouses yet).
INSERT INTO "role_assignments" ("user_id", "role_id", "warehouse_id")
SELECT ra."user_id", ra."role_id", w."id"
FROM "role_assignments" ra
JOIN "roles" r ON r."id" = ra."role_id" AND NOT r."is_system"
CROSS JOIN "warehouses" w
WHERE ra."warehouse_id" IS NULL AND w."is_active"
ON CONFLICT DO NOTHING;

DELETE FROM "role_assignments" ra
USING "roles" r
WHERE r."id" = ra."role_id" AND NOT r."is_system" AND ra."warehouse_id" IS NULL;
