-- CreateEnum
CREATE TYPE "LicenseActivationStatus" AS ENUM ('pending', 'approved', 'revoked');

-- AlterTable (نضيف الأعمدة الأول من غير قيود إجبارية)
ALTER TABLE "license_activations" ADD COLUMN "device_code" TEXT;
ALTER TABLE "license_activations" ADD COLUMN "status" "LicenseActivationStatus" NOT NULL DEFAULT 'pending';
ALTER TABLE "license_activations" ADD COLUMN "approved_at" TIMESTAMP(3);

-- تعبئة الصفوف الموجودة (لو فيه): كل جهاز شغال حاليًا يبقى approved تلقائيًا
UPDATE "license_activations"
SET "device_code" = 'LEGACY-' || substr(replace(id::text, '-', ''), 1, 8),
    "status" = 'approved',
    "approved_at" = "activated_at"
WHERE "device_code" IS NULL;

-- دلوقتي نفرض القيود الإجبارية بعد ما كل الصفوف بقى ليها قيمة
ALTER TABLE "license_activations" ALTER COLUMN "device_code" SET NOT NULL;
CREATE UNIQUE INDEX "license_activations_device_code_key" ON "license_activations"("device_code");
