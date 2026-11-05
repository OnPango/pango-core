-- CU-03: optional physical data of products, and categories that can be deactivated.

-- AlterTable
ALTER TABLE "categories" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "products" ADD COLUMN "length_cm" DECIMAL(10,2),
ADD COLUMN "width_cm" DECIMAL(10,2),
ADD COLUMN "height_cm" DECIMAL(10,2),
ADD COLUMN "weight_kg" DECIMAL(12,4),
ADD COLUMN "volume_l" DECIMAL(14,4);

-- ─── Additional constraints (hand-written SQL) ───────────────────────────────

ALTER TABLE "products" ADD CONSTRAINT "products_physical_data_chk"
    CHECK (("length_cm" IS NULL OR "length_cm" >= 0) AND ("width_cm" IS NULL OR "width_cm" >= 0)
       AND ("height_cm" IS NULL OR "height_cm" >= 0) AND ("weight_kg" IS NULL OR "weight_kg" >= 0)
       AND ("volume_l" IS NULL OR "volume_l" >= 0));

-- ─── Base data ───────────────────────────────────────────────────────────────

-- Common units of measure (UN/ECE Recommendation 20 codes), besides EA.
INSERT INTO "units_of_measure" ("code", "name") VALUES
    ('KGM', 'Kilogram'),
    ('GRM', 'Gram'),
    ('LTR', 'Litre'),
    ('MLT', 'Millilitre'),
    ('MTR', 'Metre'),
    ('BX',  'Box'),
    ('PK',  'Pack')
ON CONFLICT ("code") DO NOTHING;
