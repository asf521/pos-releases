-- CreateEnum
CREATE TYPE "LicenseType" AS ENUM ('trial', 'premium');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "licenses" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_name" TEXT,
    "contact_phone" TEXT,
    "contact_note" TEXT,
    "type" "LicenseType" NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'active',
    "activation_key" TEXT NOT NULL,
    "max_devices" INTEGER NOT NULL DEFAULT 1,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_activations" (
    "id" UUID NOT NULL,
    "license_id" UUID NOT NULL,
    "hardware_id" TEXT NOT NULL,
    "device_name" TEXT,
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "license_activations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "licenses_client_id_key" ON "licenses"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_activation_key_key" ON "licenses"("activation_key");

-- CreateIndex
CREATE INDEX "licenses_status_idx" ON "licenses"("status");

-- CreateIndex
CREATE UNIQUE INDEX "license_activations_license_id_hardware_id_key" ON "license_activations"("license_id", "hardware_id");

-- AddForeignKey
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
