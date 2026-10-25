import { Router, RequestHandler } from 'express';
import { randomBytes } from 'crypto';
import type { LicenseActivation } from '@prisma/client';
import { prisma } from './db';
import { signLicenseToken, type LicenseProduct } from './license-token';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون أحرف/أرقام ملبوسة (0/O, 1/I)

/** تاريخ "مفيش انتهاء" للترخيص full. التطبيق بيعتبر أي تاريخ بعد 2090 دائم. */
const FULL_LICENSE_EXPIRY = new Date('2099-12-31T00:00:00.000Z');

const SUPPORT_CONTACT = 'سنا للبرمجيات ت/ +201032713322';

function randomSegment(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** بادئة مفتاح التفعيل بتختلف حسب المنتج عشان العميل ماياخدش مفتاح منتج غلط: SANA-… للعيادات، POS-… للـ POS */
const KEY_PREFIX: Record<LicenseProduct, string> = { clinic: 'SANA', pos: 'POS' };

async function generateUniqueActivationKey(product: LicenseProduct): Promise<string> {
  const make = () =>
    `${KEY_PREFIX[product]}-${randomSegment(4)}-${randomSegment(4)}-${randomSegment(4)}`;
  let key = make();
  while (await prisma.license.findUnique({ where: { activationKey: key } })) {
    key = make();
  }
  return key;
}

/** كود جهاز قصير مقروء تليفونيًا — العميل بيقوله للمُورِّد عشان يوافق على الجهاز */
async function generateUniqueDeviceCode(): Promise<string> {
  let code = `${randomSegment(4)}-${randomSegment(4)}`;
  while (await prisma.licenseActivation.findUnique({ where: { deviceCode: code } })) {
    code = `${randomSegment(4)}-${randomSegment(4)}`;
  }
  return code;
}

function buildToken(product: LicenseProduct, license: {
  id: string;
  clientId: string;
  clientName: string | null;
  type: string;
  maxDevices: number;
  features: string[];
  issuedAt: Date;
  expiresAt: Date;
}, hardwareId: string) {
  return signLicenseToken({
    licenseId: license.id,
    clientId: license.clientId,
    clientName: license.clientName ?? undefined,
    type: license.type as 'trial' | 'premium' | 'full',
    maxDevices: license.maxDevices,
    features: license.features,
    hardwareId,
    issuedAt: Math.floor(license.issuedAt.getTime() / 1000),
    expiresAt: Math.floor(license.expiresAt.getTime() / 1000),
    verifiedAt: Math.floor(Date.now() / 1000),
    // الحقل ده بيتضاف لتوكن الـ POS بس — توكن العيادة بيفضل زي ما هو
    ...(product === 'pos' ? { product: 'pos' as const } : {}),
  }, product);
}

/** بيرمي استثناء بشكل {status, body} لو الترخيص ملغي/منتهي، تلتقطه الراوت اللي بينادي عليها */
function assertUsable(license: { status: string; expiresAt: Date }) {
  if (license.status === 'revoked') {
    throw { status: 403, body: { message: `تم إلغاء هذا الترخيص. برجاء التواصل مع ${SUPPORT_CONTACT}` } };
  }
  if (license.expiresAt < new Date()) {
    throw { status: 410, body: { message: `انتهت صلاحية هذا الترخيص. لتجديد الاشتراك برجاء التواصل مع ${SUPPORT_CONTACT}` } };
  }
}

/**
 * product: 'clinic' (الافتراضي — سلوك سنا سنتر القديم بالظبط) أو 'pos'.
 * نفس الكود بيتركّب مرتين في main.ts: على /api/licenses للعيادات وعلى
 * /pos/api/licenses للـ POS، وكل راوتر بيشوف تراخيص منتجه بس.
 */
export function licensesRouter(requireAdmin: RequestHandler, product: LicenseProduct = 'clinic'): Router {
  const router = Router();

  // ---------- إدارة (محمي بتسجيل دخول الأدمن) ----------

  router.get('/', requireAdmin, async (_req, res) => {
    const licenses = await prisma.license.findMany({
      where: { product },
      include: { activations: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(licenses);
  });

  router.post('/', requireAdmin, async (req, res) => {
    const { clientId, clientName, contactPhone, contactNote, type, durationDays, maxDevices, features, notes } =
      req.body ?? {};

    // full (دائم) متاح للـ POS بس — تطبيق العيادات ما يعرفش النوع ده
    const allowedTypes = product === 'pos' ? ['trial', 'premium', 'full'] : ['trial', 'premium'];
    if (!clientId || !type) {
      return res.status(400).json({ message: 'clientId و type مطلوبين' });
    }
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ message: `type لازم يكون واحد من: ${allowedTypes.join(' / ')}` });
    }
    if (type !== 'full' && !durationDays) {
      return res.status(400).json({ message: 'durationDays مطلوب' });
    }

    const existing = await prisma.license.findUnique({ where: { clientId } });
    if (existing) {
      return res.status(400).json({ message: 'يوجد ترخيص بالفعل لهذا العميل — استخدم التجديد بدلاً من الإصدار' });
    }

    const expiresAt = type === 'full' ? new Date(FULL_LICENSE_EXPIRY) : new Date();
    if (type !== 'full') expiresAt.setDate(expiresAt.getDate() + Number(durationDays));
    const activationKey = await generateUniqueActivationKey(product);

    const license = await prisma.license.create({
      data: {
        product,
        clientId,
        clientName,
        contactPhone,
        contactNote,
        type,
        activationKey,
        maxDevices: maxDevices ?? 1,
        features: features ?? [],
        expiresAt,
        notes,
      },
    });
    res.status(201).json(license);
  });

  router.patch('/:id/revoke', requireAdmin, async (req, res) => {
    const license = await prisma.license.findUnique({ where: { id: req.params.id } });
    if (!license || license.product !== product) return res.status(404).json({ message: 'الترخيص غير موجود' });

    const updated = await prisma.license.update({
      where: { id: license.id },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    res.json(updated);
  });

  /**
   * حذف نهائي — بيمسح السجل تمامًا من القاعدة (وكل أجهزته معاه، Cascade في
   * الـ schema). متاح بس للتراخيص "ملغي" أو "منتهي" — الشرط ده متحقق منه
   * هنا في الباك إند نفسه (مش بس مخفي في الواجهة)، عشان مينفعش حد يمسح
   * ترخيص "ساري" لسه شغال على جهاز عميل حقيقي حتى لو نادى الـ API مباشرة.
   */
  router.delete('/:id', requireAdmin, async (req, res) => {
    const license = await prisma.license.findUnique({ where: { id: req.params.id } });
    if (!license || license.product !== product) return res.status(404).json({ message: 'الترخيص غير موجود' });

    const isExpired = license.status === 'active' && license.expiresAt < new Date();
    const isDeletable = license.status === 'revoked' || isExpired;
    if (!isDeletable) {
      return res.status(400).json({
        message: 'الحذف متاح بس للتراخيص الملغاة أو المنتهية. ألغِ الترخيص الأول لو محتاج تمسحه.',
      });
    }

    await prisma.license.delete({ where: { id: license.id } });
    res.status(204).send();
  });

  router.patch('/:id/renew', requireAdmin, async (req, res) => {
    const { durationDays } = req.body ?? {};
    if (!durationDays || durationDays <= 0) {
      return res.status(400).json({ message: 'durationDays مطلوب وأكبر من صفر' });
    }

    const license = await prisma.license.findUnique({ where: { id: req.params.id } });
    if (!license || license.product !== product) return res.status(404).json({ message: 'الترخيص غير موجود' });

    if (license.type === 'full') {
      return res.status(400).json({ message: 'الترخيص الدائم (full) مالوش تجديد — مفيش تاريخ انتهاء.' });
    }

    const base = license.expiresAt > new Date() ? license.expiresAt : new Date();
    const expiresAt = new Date(base);
    expiresAt.setDate(expiresAt.getDate() + Number(durationDays));

    const updated = await prisma.license.update({
      where: { id: license.id },
      data: { status: 'active', revokedAt: null, expiresAt },
    });
    res.json(updated);
  });

  /** تعديل الحد الأقصى لعدد الأجهزة على ترخيص موجود */
  router.patch('/:id/max-devices', requireAdmin, async (req, res) => {
    const { maxDevices } = req.body ?? {};
    if (!maxDevices || maxDevices < 1) {
      return res.status(400).json({ message: 'عدد الأجهزة لازم يكون رقم أكبر من صفر' });
    }
    const license = await prisma.license.findUnique({ where: { id: req.params.id } });
    if (!license || license.product !== product) return res.status(404).json({ message: 'الترخيص غير موجود' });

    const updated = await prisma.license.update({
      where: { id: license.id },
      data: { maxDevices: Number(maxDevices) },
    });
    res.json(updated);
  });

  /** إلغاء تفعيل جهاز واحد بعينه — بيفضّي سلوت في maxDevices بدون ما يأثر على باقي الأجهزة */
  router.patch('/:id/devices/:activationId/revoke', requireAdmin, async (req, res) => {
    const activation = await prisma.licenseActivation.findUnique({
      where: { id: req.params.activationId },
      include: { license: true },
    });
    if (!activation || activation.licenseId !== req.params.id || activation.license.product !== product) {
      return res.status(404).json({ message: 'الجهاز غير موجود على هذا الترخيص' });
    }
    // ترخيص الـ POS مربوط بالجهاز نهائيًا: مفيش تحرير للمكان ولا نقل لجهاز تاني.
    // لو العميل محتاج جهاز تاني تصدر له ترخيص جديد.
    if (product === 'pos') {
      return res.status(403).json({
        message: 'تراخيص الـ POS مربوطة بالجهاز نهائيًا ولا يمكن نقلها. لجهاز جديد أصدر ترخيصًا جديدًا.',
        code: 'POS_DEVICE_LOCKED',
      });
    }
    if (activation.revokedAt) {
      return res.status(400).json({ message: 'هذا الجهاز ملغى بالفعل' });
    }

    const updated = await prisma.licenseActivation.update({
      where: { id: activation.id },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    res.json(updated);
  });

  /** موافقة الأدمن على جهاز pending — بيستخدم كود الجهاز القصير */
  router.post('/devices/approve', requireAdmin, async (req, res) => {
    const { deviceCode } = req.body ?? {};
    if (!deviceCode) return res.status(400).json({ message: 'deviceCode مطلوب' });

    const activation = await prisma.licenseActivation.findUnique({
      where: { deviceCode },
      include: { license: true },
    });
    if (!activation || activation.license.product !== product) {
      return res.status(404).json({ message: 'كود الجهاز غير صحيح' });
    }
    if (activation.revokedAt) {
      return res.status(400).json({ message: 'هذا الجهاز ملغى، مينفعش يتوافق عليه' });
    }
    if (activation.status === 'approved') {
      return res.status(400).json({ message: 'هذا الجهاز متوافق عليه بالفعل' });
    }

    const updated = await prisma.licenseActivation.update({
      where: { id: activation.id },
      data: { status: 'approved', approvedAt: new Date() },
    });
    res.json(updated);
  });

  // ---------- تطبيق سطح المكتب للعميل (عام — بدون تسجيل دخول) ----------
  // ملاحظة أمان: مفيش guard هنا عن قصد. الحماية من إساءة الاستخدام قائمة على:
  //   1) مفتاح تفعيل عشوائي 12 حرف (33^12 احتمال) صعب التخمين
  //   2) rate limiting عام على مستوى السيرفر (راجع main.ts)
  //   3) عدد الأجهزة محكوم بـ maxDevices بغض النظر عن عدد المحاولات
  //   4) جهاز جديد على ترخيص premium محتاج موافقة يدوية منك قبل ما ياخد توكن فعلي

  router.post('/activate', async (req, res) => {
    try {
      const { activationKey, hardwareId, deviceName } = req.body ?? {};
      if (!activationKey || !hardwareId) {
        return res.status(400).json({ message: 'activationKey و hardwareId مطلوبين' });
      }

      const license = await prisma.license.findUnique({
        where: { activationKey },
        include: { activations: true },
      });
      if (!license || license.product !== product) return res.status(404).json({ message: 'مفتاح التفعيل غير صحيح' });

      assertUsable(license);

      const existingActivation = license.activations.find(
        (a: LicenseActivation) => a.hardwareId === hardwareId && !a.revokedAt,
      );

      // ---- جهاز اتفعّل قبل كده على نفس الترخيص ----
      if (existingActivation) {
        if (existingActivation.status === 'pending') {
          return res.status(200).json({
            pending: true,
            deviceCode: existingActivation.deviceCode,
            message:
              `الجهاز ده لسه بانتظار موافقة الأدمن. اديله كود الجهاز ده: ${existingActivation.deviceCode} ` +
              `وكلّم ${SUPPORT_CONTACT} للموافقة.`,
          });
        }

        await prisma.licenseActivation.update({
          where: { id: existingActivation.id },
          data: { lastVerifiedAt: new Date(), deviceName: deviceName ?? existingActivation.deviceName },
        });
        return res.status(201).json({ token: buildToken(product, license, hardwareId) });
      }

      // ---- جهاز جديد تمامًا ----
      // العدّاد بيحسب pending + approved (مش revoked بس) عشان محدش يقدر يعمل
      // سبام بطلبات pending أكتر من maxDevices ويكدّس الطابور.
      const activeCount = license.activations.filter((a: LicenseActivation) => !a.revokedAt).length;
      if (activeCount >= license.maxDevices) {
        return res.status(403).json({
          message:
            `تم الوصول للحد الأقصى من الأجهزة المسموح بها (${license.maxDevices}). ` +
            `للتفعيل على جهاز جديد أو إلغاء تفعيل جهاز قديم، برجاء التواصل مع ${SUPPORT_CONTACT}`,
        });
      }

      const deviceCode = await generateUniqueDeviceCode();

      // Trial: موافقة تلقائية فورية (تجربة بدون احتكاك). Premium: لازم موافقة يدوية.
      const autoApprove = license.type === 'trial';

      const activation = await prisma.licenseActivation.create({
        data: {
          licenseId: license.id,
          hardwareId,
          deviceName,
          deviceCode,
          status: autoApprove ? 'approved' : 'pending',
          approvedAt: autoApprove ? new Date() : null,
        },
      });

      if (!autoApprove) {
        return res.status(200).json({
          pending: true,
          deviceCode: activation.deviceCode,
          message:
            `الجهاز محتاج موافقة الأدمن الأول. اديله كود الجهاز ده: ${activation.deviceCode} ` +
            `وكلّم ${SUPPORT_CONTACT} للموافقة، وبعدها اضغط "تحقق" تاني.`,
        });
      }

      return res.status(201).json({ token: buildToken(product, license, hardwareId) });
    } catch (err: unknown) {
      const e = err as { status?: number; body?: unknown };
      if (e?.status) return res.status(e.status).json(e.body);
      console.error(err);
      return res.status(500).json({ message: 'حدث خطأ غير متوقع' });
    }
  });

  router.post('/verify', async (req, res) => {
    try {
      const { activationKey, hardwareId } = req.body ?? {};
      if (!activationKey || !hardwareId) {
        return res.status(400).json({ message: 'activationKey و hardwareId مطلوبين' });
      }

      const license = await prisma.license.findUnique({
        where: { activationKey },
        include: { activations: true },
      });
      if (!license || license.product !== product) return res.status(404).json({ message: 'مفتاح التفعيل غير صحيح' });

      assertUsable(license);

      const activation = license.activations.find(
        (a: LicenseActivation) => a.hardwareId === hardwareId && !a.revokedAt,
      );
      if (!activation) {
        return res.status(403).json({
          message: `هذا الجهاز غير مفعّل على هذا الترخيص. برجاء التواصل مع ${SUPPORT_CONTACT}`,
        });
      }
      if (activation.status === 'pending') {
        return res.status(403).json({
          pending: true,
          deviceCode: activation.deviceCode,
          message:
            `الجهاز ده لسه بانتظار موافقة الأدمن. اديله كود الجهاز ده: ${activation.deviceCode} ` +
            `وكلّم ${SUPPORT_CONTACT} للموافقة.`,
        });
      }

      await prisma.licenseActivation.update({
        where: { id: activation.id },
        data: { lastVerifiedAt: new Date() },
      });

      return res.status(201).json({ token: buildToken(product, license, hardwareId) });
    } catch (err: unknown) {
      const e = err as { status?: number; body?: unknown };
      if (e?.status) return res.status(e.status).json(e.body);
      console.error(err);
      return res.status(500).json({ message: 'حدث خطأ غير متوقع' });
    }
  });

  return router;
}
