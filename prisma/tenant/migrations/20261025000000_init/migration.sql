-- CreateEnum
CREATE TYPE "permission_scope" AS ENUM ('ORGANIZATION', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "attribute_data_type" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'LIST');

-- CreateEnum
CREATE TYPE "movement_nature" AS ENUM ('INBOUND', 'OUTBOUND', 'TRANSFER', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "movement_status" AS ENUM ('DRAFT', 'IN_TRANSIT', 'CONFIRMED', 'VOIDED');

-- CreateEnum
CREATE TYPE "stock_request_status" AS ENUM ('PENDING', 'APPROVED', 'PARTIAL', 'FULFILLED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "granularity" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "costing_method" AS ENUM ('WEIGHTED_AVERAGE');

-- CreateEnum
CREATE TYPE "forecast_run_status" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "forecast_model" AS ENUM ('BASELINE', 'SARIMA', 'XGBOOST');

-- CreateEnum
CREATE TYPE "demand_class" AS ENUM ('SMOOTH', 'INTERMITTENT', 'ERRATIC', 'LUMPY');

-- CreateEnum
CREATE TYPE "replenishment_method" AS ENUM ('MIN_MAX', 'FIXED_ROP', 'FORECAST_ROP');

-- CreateEnum
CREATE TYPE "value_source" AS ENUM ('MANUAL', 'CALCULATED');

-- CreateEnum
CREATE TYPE "alert_type" AS ENUM ('BELOW_ROP', 'STOCKOUT', 'OVERSTOCK');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateTable
CREATE TABLE "settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL DEFAULT 'COP',
    "time_zone" VARCHAR(40) NOT NULL DEFAULT 'America/Bogota',
    "forecast_granularity" "granularity" NOT NULL DEFAULT 'WEEKLY',
    "costing_method" "costing_method" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "reservation_expiry_days" INTEGER,
    "replenishment_movement_type_id" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "cost_center" VARCHAR(30),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "department_id" INTEGER,
    "job_title" VARCHAR(80),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "scope" "permission_scope" NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_movement_types" (
    "role_id" INTEGER NOT NULL,
    "movement_type_id" INTEGER NOT NULL,

    CONSTRAINT "role_movement_types_pkey" PRIMARY KEY ("role_id","movement_type_id")
);

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" SERIAL NOT NULL,
    "role_id" INTEGER NOT NULL,
    "alert_type" "alert_type" NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units_of_measure" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(40) NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "sku" VARCHAR(40) NOT NULL,
    "category_id" INTEGER NOT NULL,
    "unit_of_measure_id" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "tracks_lots" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "average_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" SERIAL NOT NULL,
    "tax_id" VARCHAR(20) NOT NULL,
    "legal_name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(30),
    "email" VARCHAR(150),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "supplier_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "purchase_price" DECIMAL(14,4) NOT NULL,
    "lead_time_days" INTEGER NOT NULL,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("supplier_id","product_id")
);

-- CreateTable
CREATE TABLE "custom_attributes" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER,
    "name" VARCHAR(60) NOT NULL,
    "data_type" "attribute_data_type" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_options" (
    "id" SERIAL NOT NULL,
    "attribute_id" INTEGER NOT NULL,
    "value" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attribute_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_values" (
    "product_id" INTEGER NOT NULL,
    "attribute_id" INTEGER NOT NULL,
    "text_value" TEXT,
    "number_value" DECIMAL(18,6),
    "date_value" DATE,
    "boolean_value" BOOLEAN,
    "option_id" INTEGER,

    CONSTRAINT "attribute_values_pkey" PRIMARY KEY ("product_id","attribute_id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "address" VARCHAR(200),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_levels" (
    "id" SERIAL NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "depth" SMALLINT NOT NULL,

    CONSTRAINT "location_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "level_id" INTEGER NOT NULL,
    "parent_id" INTEGER,
    "code" VARCHAR(40) NOT NULL,
    "capacity" DECIMAL(14,4),
    "capacity_unit_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_warehouses" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "default_location_id" INTEGER,
    "base_forecast_id" INTEGER,
    "replenishment_method" "replenishment_method" NOT NULL DEFAULT 'FIXED_ROP',
    "service_level" DECIMAL(4,3) NOT NULL DEFAULT 0.95,
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "min_stock" DECIMAL(14,4),
    "max_stock" DECIMAL(14,4),
    "safety_stock" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "reorder_point" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "value_source" "value_source" NOT NULL DEFAULT 'MANUAL',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lots" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "manufacture_date" DATE,
    "expiry_date" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" SERIAL NOT NULL,
    "product_warehouse_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "lot_id" INTEGER,
    "quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_types" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "nature" "movement_nature" NOT NULL,
    "counts_as_demand" BOOLEAN NOT NULL DEFAULT false,
    "is_base" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movement_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movements" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "movement_type_id" INTEGER NOT NULL,
    "registered_by_id" INTEGER NOT NULL,
    "received_by_id" INTEGER,
    "stock_request_id" INTEGER,
    "supplier_id" INTEGER,
    "department_id" INTEGER,
    "reversal_of_id" INTEGER,
    "status" "movement_status" NOT NULL DEFAULT 'DRAFT',
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ,
    "document_ref" VARCHAR(40),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_lines" (
    "movement_id" INTEGER NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "origin_location_id" INTEGER,
    "destination_location_id" INTEGER,
    "lot_id" INTEGER,
    "quantity" DECIMAL(14,4) NOT NULL,
    "received_quantity" DECIMAL(14,4),
    "unit_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,

    CONSTRAINT "movement_lines_pkey" PRIMARY KEY ("movement_id","line_number")
);

-- CreateTable
CREATE TABLE "stock_requests" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "requested_by_id" INTEGER NOT NULL,
    "department_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "status" "stock_request_status" NOT NULL DEFAULT 'PENDING',
    "priority" SMALLINT NOT NULL DEFAULT 2,
    "required_date" DATE,
    "reservation_expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_request_lines" (
    "stock_request_id" INTEGER NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "requested_quantity" DECIMAL(14,4) NOT NULL,
    "reserved_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,

    CONSTRAINT "stock_request_lines_pkey" PRIMARY KEY ("stock_request_id","line_number")
);

-- CreateTable
CREATE TABLE "forecast_runs" (
    "id" SERIAL NOT NULL,
    "granularity" "granularity" NOT NULL,
    "horizon" SMALLINT NOT NULL,
    "status" "forecast_run_status" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "forecast_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecasts" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "product_warehouse_id" INTEGER NOT NULL,
    "model" "forecast_model" NOT NULL,
    "demand_class" "demand_class" NOT NULL,
    "error_metric" VARCHAR(10) NOT NULL,
    "error_value" DECIMAL(14,6) NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_periods" (
    "forecast_id" INTEGER NOT NULL,
    "period_start" DATE NOT NULL,
    "estimated_demand" DECIMAL(14,4) NOT NULL,
    "lower_bound" DECIMAL(14,4) NOT NULL,
    "upper_bound" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "forecast_periods_pkey" PRIMARY KEY ("forecast_id","period_start")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" SERIAL NOT NULL,
    "product_warehouse_id" INTEGER NOT NULL,
    "draft_movement_id" INTEGER,
    "type" "alert_type" NOT NULL,
    "severity" SMALLINT NOT NULL DEFAULT 1,
    "status" "alert_status" NOT NULL DEFAULT 'OPEN',
    "suggested_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "alert_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("alert_id","user_id","channel")
);

-- CreateIndex
CREATE INDEX "settings_replenishment_movement_type_id_idx" ON "settings"("replenishment_movement_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_account_id_key" ON "users"("account_id");

-- CreateIndex
CREATE INDEX "users_department_id_idx" ON "users"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "role_assignments_role_id_idx" ON "role_assignments"("role_id");

-- CreateIndex
CREATE INDEX "role_assignments_warehouse_id_idx" ON "role_assignments"("warehouse_id");

-- CreateIndex
CREATE INDEX "role_movement_types_movement_type_id_idx" ON "role_movement_types"("movement_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_rules_role_id_alert_type_channel_key" ON "notification_rules"("role_id", "alert_type", "channel");

-- CreateIndex
CREATE INDEX "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_of_measure_code_key" ON "units_of_measure"("code");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "products_unit_of_measure_id_idx" ON "products"("unit_of_measure_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tax_id_key" ON "suppliers"("tax_id");

-- CreateIndex
CREATE INDEX "supplier_products_product_id_idx" ON "supplier_products"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_attributes_name_key" ON "custom_attributes"("name");

-- CreateIndex
CREATE INDEX "custom_attributes_category_id_idx" ON "custom_attributes"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_options_attribute_id_value_key" ON "attribute_options"("attribute_id", "value");

-- CreateIndex
CREATE INDEX "attribute_values_attribute_id_idx" ON "attribute_values"("attribute_id");

-- CreateIndex
CREATE INDEX "attribute_values_option_id_idx" ON "attribute_values"("option_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "location_levels_warehouse_id_depth_key" ON "location_levels"("warehouse_id", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "locations_code_key" ON "locations"("code");

-- CreateIndex
CREATE INDEX "locations_level_id_idx" ON "locations"("level_id");

-- CreateIndex
CREATE INDEX "locations_parent_id_idx" ON "locations"("parent_id");

-- CreateIndex
CREATE INDEX "locations_capacity_unit_id_idx" ON "locations"("capacity_unit_id");

-- CreateIndex
CREATE INDEX "product_warehouses_warehouse_id_idx" ON "product_warehouses"("warehouse_id");

-- CreateIndex
CREATE INDEX "product_warehouses_default_location_id_idx" ON "product_warehouses"("default_location_id");

-- CreateIndex
CREATE INDEX "product_warehouses_base_forecast_id_idx" ON "product_warehouses"("base_forecast_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_warehouses_product_id_warehouse_id_key" ON "product_warehouses"("product_id", "warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "lots_product_id_code_key" ON "lots"("product_id", "code");

-- CreateIndex
CREATE INDEX "stock_balances_location_id_idx" ON "stock_balances"("location_id");

-- CreateIndex
CREATE INDEX "stock_balances_lot_id_idx" ON "stock_balances"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "movement_types_name_key" ON "movement_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "movements_number_key" ON "movements"("number");

-- CreateIndex
CREATE UNIQUE INDEX "movements_reversal_of_id_key" ON "movements"("reversal_of_id");

-- CreateIndex
CREATE INDEX "movements_movement_type_id_idx" ON "movements"("movement_type_id");

-- CreateIndex
CREATE INDEX "movements_registered_by_id_idx" ON "movements"("registered_by_id");

-- CreateIndex
CREATE INDEX "movements_received_by_id_idx" ON "movements"("received_by_id");

-- CreateIndex
CREATE INDEX "movements_stock_request_id_idx" ON "movements"("stock_request_id");

-- CreateIndex
CREATE INDEX "movements_supplier_id_idx" ON "movements"("supplier_id");

-- CreateIndex
CREATE INDEX "movements_department_id_idx" ON "movements"("department_id");

-- CreateIndex
CREATE INDEX "movements_status_idx" ON "movements"("status");

-- CreateIndex
CREATE INDEX "movements_occurred_at_idx" ON "movements"("occurred_at");

-- CreateIndex
CREATE INDEX "movement_lines_product_id_idx" ON "movement_lines"("product_id");

-- CreateIndex
CREATE INDEX "movement_lines_origin_location_id_idx" ON "movement_lines"("origin_location_id");

-- CreateIndex
CREATE INDEX "movement_lines_destination_location_id_idx" ON "movement_lines"("destination_location_id");

-- CreateIndex
CREATE INDEX "movement_lines_lot_id_idx" ON "movement_lines"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_requests_number_key" ON "stock_requests"("number");

-- CreateIndex
CREATE INDEX "stock_requests_warehouse_id_status_idx" ON "stock_requests"("warehouse_id", "status");

-- CreateIndex
CREATE INDEX "stock_requests_requested_by_id_idx" ON "stock_requests"("requested_by_id");

-- CreateIndex
CREATE INDEX "stock_requests_department_id_idx" ON "stock_requests"("department_id");

-- CreateIndex
CREATE INDEX "stock_request_lines_product_id_idx" ON "stock_request_lines"("product_id");

-- CreateIndex
CREATE INDEX "forecasts_run_id_idx" ON "forecasts"("run_id");

-- CreateIndex
CREATE INDEX "forecasts_product_warehouse_id_idx" ON "forecasts"("product_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_draft_movement_id_key" ON "alerts"("draft_movement_id");

-- CreateIndex
CREATE INDEX "alerts_product_warehouse_id_status_idx" ON "alerts"("product_warehouse_id", "status");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_replenishment_movement_type_id_fkey" FOREIGN KEY ("replenishment_movement_type_id") REFERENCES "movement_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_movement_types" ADD CONSTRAINT "role_movement_types_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_movement_types" ADD CONSTRAINT "role_movement_types_movement_type_id_fkey" FOREIGN KEY ("movement_type_id") REFERENCES "movement_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_unit_of_measure_id_fkey" FOREIGN KEY ("unit_of_measure_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_attributes" ADD CONSTRAINT "custom_attributes_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_options" ADD CONSTRAINT "attribute_options_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "custom_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_attribute_id_fkey" FOREIGN KEY ("attribute_id") REFERENCES "custom_attributes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "attribute_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_levels" ADD CONSTRAINT "location_levels_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "location_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_capacity_unit_id_fkey" FOREIGN KEY ("capacity_unit_id") REFERENCES "units_of_measure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_warehouses" ADD CONSTRAINT "product_warehouses_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_warehouses" ADD CONSTRAINT "product_warehouses_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_warehouses" ADD CONSTRAINT "product_warehouses_default_location_id_fkey" FOREIGN KEY ("default_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_warehouses" ADD CONSTRAINT "product_warehouses_base_forecast_id_fkey" FOREIGN KEY ("base_forecast_id") REFERENCES "forecasts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lots" ADD CONSTRAINT "lots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_warehouse_id_fkey" FOREIGN KEY ("product_warehouse_id") REFERENCES "product_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_movement_type_id_fkey" FOREIGN KEY ("movement_type_id") REFERENCES "movement_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_received_by_id_fkey" FOREIGN KEY ("received_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_stock_request_id_fkey" FOREIGN KEY ("stock_request_id") REFERENCES "stock_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "movements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_origin_location_id_fkey" FOREIGN KEY ("origin_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_requests" ADD CONSTRAINT "stock_requests_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_stock_request_id_fkey" FOREIGN KEY ("stock_request_id") REFERENCES "stock_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "forecast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_product_warehouse_id_fkey" FOREIGN KEY ("product_warehouse_id") REFERENCES "product_warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_periods" ADD CONSTRAINT "forecast_periods_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "forecasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_product_warehouse_id_fkey" FOREIGN KEY ("product_warehouse_id") REFERENCES "product_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_draft_movement_id_fkey" FOREIGN KEY ("draft_movement_id") REFERENCES "movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Additional constraints (hand-written SQL) ───────────────────────────────
-- Prisma cannot express these in schema.prisma. When generating future
-- migrations, make sure Prisma does not try to drop them.

ALTER TABLE "settings" ADD CONSTRAINT "settings_singleton_chk" CHECK ("id" = 1);

-- NULL must count as a value (PostgreSQL 15+). The leading column also serves
-- as the index for the user_id / product_warehouse_id foreign keys.
CREATE UNIQUE INDEX "role_assignments_user_role_warehouse_key"
    ON "role_assignments"("user_id", "role_id", "warehouse_id") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "stock_balances_product_warehouse_location_lot_key"
    ON "stock_balances"("product_warehouse_id", "location_id", "lot_id") NULLS NOT DISTINCT;

-- At most one preferred supplier per product and one current forecast per product-warehouse.
CREATE UNIQUE INDEX "supplier_products_preferred_key" ON "supplier_products"("product_id") WHERE "is_preferred";
CREATE UNIQUE INDEX "forecasts_current_key" ON "forecasts"("product_warehouse_id") WHERE "is_current";

ALTER TABLE "attribute_values" ADD CONSTRAINT "attribute_values_single_value_chk"
    CHECK (num_nonnulls("text_value", "number_value", "date_value", "boolean_value", "option_id") = 1);
ALTER TABLE "stock_request_lines" ADD CONSTRAINT "stock_request_lines_quantities_chk"
    CHECK ("requested_quantity" > 0 AND "reserved_quantity" BETWEEN 0 AND "requested_quantity");
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_quantities_chk"
    CHECK ("quantity" > 0 AND ("received_quantity" IS NULL OR "received_quantity" BETWEEN 0 AND "quantity"));
ALTER TABLE "movement_lines" ADD CONSTRAINT "movement_lines_location_chk"
    CHECK (num_nonnulls("origin_location_id", "destination_location_id") >= 1);
ALTER TABLE "movements" ADD CONSTRAINT "movements_reversal_chk"
    CHECK ("reversal_of_id" IS NULL OR "reversal_of_id" <> "id");
ALTER TABLE "product_warehouses" ADD CONSTRAINT "product_warehouses_parameters_chk"
    CHECK ("service_level" > 0 AND "service_level" < 1 AND "lead_time_days" >= 0
       AND ("min_stock" IS NULL OR "max_stock" IS NULL OR "max_stock" >= "min_stock"));
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_values_chk"
    CHECK ("purchase_price" >= 0 AND "lead_time_days" >= 0);
ALTER TABLE "location_levels" ADD CONSTRAINT "location_levels_depth_chk" CHECK ("depth" >= 1);
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_horizon_chk" CHECK ("horizon" >= 1);
ALTER TABLE "forecast_periods" ADD CONSTRAINT "forecast_periods_bounds_chk"
    CHECK ("lower_bound" <= "estimated_demand" AND "estimated_demand" <= "upper_bound");
