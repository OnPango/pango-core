-- Base data, identical for every organization. It lives in a migration (not a
-- seed) so every new tenant is born with it.
-- Any future migration that adds a permission must also grant it to the Owner role.

-- Fixed permission catalog
INSERT INTO "permissions" ("code", "module", "scope", "description") VALUES
    ('user.read',              'user',          'ORGANIZATION', 'View the organization''s users'),
    ('user.manage',            'user',          'ORGANIZATION', 'Create, edit and deactivate users'),
    ('role.read',              'role',          'ORGANIZATION', 'View roles and their permissions'),
    ('role.manage',            'role',          'ORGANIZATION', 'Create and edit roles and role assignments'),
    ('department.manage',      'department',    'ORGANIZATION', 'Create and edit departments'),
    ('settings.manage',        'settings',      'ORGANIZATION', 'Edit organization settings'),
    ('warehouse.manage',       'warehouse',     'ORGANIZATION', 'Create and edit warehouses'),
    ('catalog.read',           'catalog',       'ORGANIZATION', 'View the product catalog'),
    ('product.manage',         'product',       'ORGANIZATION', 'Create and edit products'),
    ('category.manage',        'category',      'ORGANIZATION', 'Create and edit categories'),
    ('attribute.manage',       'attribute',     'ORGANIZATION', 'Create and edit custom attributes'),
    ('supplier.manage',        'supplier',      'ORGANIZATION', 'Create and edit suppliers and their products'),
    ('movement_type.manage',   'movement_type', 'ORGANIZATION', 'Create and edit movement types'),
    ('forecast.run',           'forecast',      'ORGANIZATION', 'Start forecast runs'),
    ('notification.manage',    'notification',  'ORGANIZATION', 'Configure notification rules'),
    ('warehouse.read',         'warehouse',     'WAREHOUSE',    'View the warehouse'),
    ('location.manage',        'location',      'WAREHOUSE',    'Create and edit location levels and locations'),
    ('stock.read',             'stock',         'WAREHOUSE',    'View stock balances and available stock'),
    ('replenishment.manage',   'replenishment', 'WAREHOUSE',    'Edit replenishment parameters'),
    ('movement.read',          'movement',      'WAREHOUSE',    'View movements'),
    ('movement.create',        'movement',      'WAREHOUSE',    'Register draft movements'),
    ('movement.confirm',       'movement',      'WAREHOUSE',    'Confirm or dispatch movements'),
    ('movement.receive',       'movement',      'WAREHOUSE',    'Receive in-transit transfers'),
    ('movement.void',          'movement',      'WAREHOUSE',    'Void confirmed movements'),
    ('stock_request.read',     'stock_request', 'WAREHOUSE',    'View stock requests'),
    ('stock_request.create',   'stock_request', 'WAREHOUSE',    'Create stock requests'),
    ('stock_request.approve',  'stock_request', 'WAREHOUSE',    'Approve, reject or cancel stock requests'),
    ('forecast.read',          'forecast',      'WAREHOUSE',    'View forecasts'),
    ('alert.read',             'alert',         'WAREHOUSE',    'View alerts'),
    ('alert.resolve',          'alert',         'WAREHOUSE',    'Resolve or dismiss alerts');

-- Base movement types
INSERT INTO "movement_types" ("name", "nature", "counts_as_demand", "is_base") VALUES
    ('Opening balance',      'INBOUND',    false, true),
    ('Purchase receipt',     'INBOUND',    false, true),
    ('Consumption issue',    'OUTBOUND',   true,  true),
    ('Transfer',             'TRANSFER',   false, true),
    ('Inventory adjustment', 'ADJUSTMENT', false, true);

-- Default unit of measure (UN/ECE Recommendation 20 code)
INSERT INTO "units_of_measure" ("code", "name") VALUES ('EA', 'Each');

-- Owner role with every permission and every movement type
INSERT INTO "roles" ("name", "description", "is_system")
VALUES ('Owner', 'Full access to the organization', true);

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE r."name" = 'Owner';

INSERT INTO "role_movement_types" ("role_id", "movement_type_id")
SELECT r."id", t."id" FROM "roles" r CROSS JOIN "movement_types" t WHERE r."name" = 'Owner';

-- Settings (single row); automatic replenishment drafts use "Purchase receipt"
INSERT INTO "settings" ("id", "replenishment_movement_type_id")
SELECT 1, t."id" FROM "movement_types" t WHERE t."name" = 'Purchase receipt';
