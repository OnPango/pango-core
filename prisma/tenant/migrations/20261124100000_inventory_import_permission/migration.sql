-- Inventory import (docs/modules/inventary.md): a warehouse-scope permission that
-- authorizes a whole import. Owner (the system role) and Admin get it by default,
-- Operator does not; custom roles are left as they are, and the Owner grants it to
-- them through role management. Data only: no schema change.
INSERT INTO "permissions" ("code", "module", "scope", "description")
VALUES ('inventory.import', 'inventory', 'WAREHOUSE', 'Import an opening of current stock from the inventory template');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."is_system" OR r."name" = 'Admin') AND p."code" = 'inventory.import'
ON CONFLICT DO NOTHING;
