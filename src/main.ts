import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { requireAdmin, loginHandler } from './auth';
import { licensesRouter } from './licenses.routes';
import { updatesRouter } from './updates.routes';

const app = express();
const PORT = Number(process.env.PORT) || 4100;

// السيرفر شغال ورا بروكسي Render. من غير السطر ده كل العملاء بيظهروا بنفس
// الـ IP (بتاع البروكسي) وبيتشاركوا نفس حد الـ rate limit (100 طلب/دقيقة لكل
// الدنيا). بيخلّي Express ياخد الـ IP الحقيقي للعميل من X-Forwarded-For.
app.set('trust proxy', 1);

app.use(express.json());
app.use(
  cors({
    origin: true, // سيرفر تراخيص عام — بيتنادى من تطبيقات سطح مكتب لعملاء مختلفين على أجهزة مختلفة
    credentials: true,
  }),
);

// حماية عامة ضد محاولات التخمين على أي endpoint
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', loginHandler);

// =========================================================================
// سنا سنتر (العيادات) — المسارات القديمة زي ما هي، متعدّلتش
// كل الـ endpoints الإدارية محمية بتسجيل دخول الأدمن. أما /licenses/activate
// و /licenses/verify فعامة (بتتنادى من تطبيقات العملاء قبل أي تسجيل دخول)،
// الحماية عليها مفتاح التفعيل نفسه + rate limiting.
// =========================================================================
app.use('/api/licenses', licensesRouter(requireAdmin, 'clinic'));
app.use('/api/updates', updatesRouter(requireAdmin));

// =========================================================================
// SanaSoftware POS — مسار منفصل تمامًا تحت /pos عشان تراخيصه وتحديثاته
// مايتلخبطوش مع العيادات. تطبيق الـ POS بيضبط عنوان السيرفر على
// https://license-server-byfd.onrender.com/pos وبينادي نفس المسارات النسبية:
//   POST /pos/api/licenses/activate | /verify
//   GET  /pos/api/updates/POS/latest.json
// (مسار /api/updates/POS/* القديم لسه شغال كمان عشان نسخ POS اللي اتثبتت قبل كده
// وسكريبت النشر الحالي.)
// =========================================================================
app.get('/pos/api/health', (_req, res) => res.json({ ok: true, product: 'pos' }));
app.post('/pos/api/auth/login', loginHandler);
app.use('/pos/api/licenses', licensesRouter(requireAdmin, 'pos'));
app.use('/pos/api/updates', updatesRouter(requireAdmin));

// لوحة التحكم — صفحة واحدة ثابتة (HTML+JS عادي، بدون build step).
// نفس الصفحة بتتخدم على / (العيادات) وعلى /pos/ (الـ POS) وهي بتعرف المنتج من العنوان.
const publicDir = path.join(__dirname, '..', 'public');
app.use('/pos', express.static(publicDir));
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`✅ سيرفر التراخيص شغال على http://localhost:${PORT}`);
  console.log(`   لوحة العيادات: http://localhost:${PORT}/`);
  console.log(`   لوحة الـ POS:   http://localhost:${PORT}/pos/`);
});
