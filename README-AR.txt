سيرفر التراخيص — دعم SanaSoftware POS تحت /pos
================================================
فك الضغط فوق مجلد license-server (نفس مسارات الملفات).

معدّل: prisma/schema.prisma (عمود product), src/main.ts, src/license-token.ts,
       src/licenses.routes.ts, public/index.html
جديد:  prisma/migrations/20261024120000_add_license_product/migration.sql
       scripts/generate-pos-license-keys.cjs

الخطوات:
  1) node scripts/generate-pos-license-keys.cjs
     هيطبع سطر طويل — حطه في Render > Environment باسم POS_LICENSE_PRIVATE_KEY
     (ماترفعش مجلد keys على GitHub. ضيف keys/ في .gitignore)
  2) ارفع التعديلات وشغّل المايجريشن:  npx prisma migrate deploy
     (تراخيص العيادات الحالية بتاخد product = clinic تلقائيًا ومبتتأثرش)
  3) لوحة الـ POS: https://license-server-byfd.onrender.com/pos/
     لوحة العيادات زي ما هي: https://license-server-byfd.onrender.com/

ملاحظات:
  - مسار التحديثات الجديد: /pos/api/updates/POS ... والقديم /api/updates/POS لسه شغال
  - اتضاف trust proxy عشان حد الطلبات يتحسب لكل عميل مش للبروكسي كله
  - نوع الترخيص الجديد full (للـ POS بس): دائم، مالوش تجديد، بيقف بالإلغاء فقط. شغّل prisma migrate deploy
    عشان يتضاف النوع في قاعدة البيانات (migration 20261024130000)
  - منع النقل (POS): الترخيص بيتربط بالجهاز نهائيًا. السيرفر بيرفض "إلغاء الجهاز" لتراخيص الـ POS
    وزرار إلغاء الجهاز مخفي في لوحة /pos/. لجهاز جديد تصدر ترخيص جديد.
  - بصمة الجهاز في التطبيق بقت UUID بتاع الـ BIOS + سيريال اللوحة الأم (نسخ الويندوز لجهاز تاني مايشتغلش،
    وفورمات نفس الجهاز مابيغيّرش البصمة). لو الجهاز مفيهوش قيم حقيقية بتتحول لـ MachineGuid.
