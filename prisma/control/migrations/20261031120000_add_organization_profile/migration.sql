-- Organization profile: optional tax_id plus location, sector, team size,
-- product count and contact phone. Existing rows are backfilled with
-- placeholder values before the columns become NOT NULL.

-- CreateEnum
CREATE TYPE "business_sector" AS ENUM ('RETAIL', 'WHOLESALE', 'MANUFACTURING', 'FOOD_AND_BEVERAGE', 'PHARMACY_AND_HEALTH', 'HARDWARE_AND_CONSTRUCTION', 'FASHION_AND_APPAREL', 'TECHNOLOGY', 'AGRICULTURE', 'SERVICES', 'OTHER');

-- CreateEnum
CREATE TYPE "team_size" AS ENUM ('SIZE_1_5', 'SIZE_6_20', 'SIZE_21_50', 'SIZE_51_200', 'SIZE_201_PLUS');

-- CreateEnum
CREATE TYPE "product_count" AS ENUM ('COUNT_1_100', 'COUNT_101_500', 'COUNT_501_2000', 'COUNT_2001_10000', 'COUNT_10001_PLUS');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "business_sector" "business_sector",
ADD COLUMN     "city" VARCHAR(100),
ADD COLUMN     "contact_phone" VARCHAR(20),
ADD COLUMN     "country" CHAR(2),
ADD COLUMN     "product_count" "product_count",
ADD COLUMN     "team_size" "team_size",
ALTER COLUMN "tax_id" DROP NOT NULL;

-- Backfill existing organizations
UPDATE "organizations" SET
  "country" = 'CO',
  "city" = 'Bogotá',
  "business_sector" = 'OTHER',
  "team_size" = 'SIZE_1_5',
  "product_count" = 'COUNT_1_100';

ALTER TABLE "organizations" ALTER COLUMN "business_sector" SET NOT NULL,
ALTER COLUMN "city" SET NOT NULL,
ALTER COLUMN "country" SET NOT NULL,
ALTER COLUMN "product_count" SET NOT NULL,
ALTER COLUMN "team_size" SET NOT NULL;

-- Hand-written: country must be an uppercase ISO 3166-1 alpha-2 code
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_country_chk" CHECK ("country" ~ '^[A-Z]{2}$');
