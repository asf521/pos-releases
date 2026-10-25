-- فصل تراخيص المنتجات: كل الصفوف الموجودة (العيادات) بتاخد 'clinic' تلقائيًا.
ALTER TABLE "licenses" ADD COLUMN "product" TEXT NOT NULL DEFAULT 'clinic';
CREATE INDEX "licenses_product_idx" ON "licenses"("product");
