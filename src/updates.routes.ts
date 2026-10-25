import { Router, RequestHandler } from 'express';
import { prisma } from './db';

/** مقارنة أرقام إصدار بسيطة على شكل "1.2.3" — بيرجع true لو a أحدث من b */
function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

/** شكل الـ manifest الموقّع اللي بيبعته سكريبت النشر بتاع الباك إند (Ed25519 مخصص). */
interface BackendManifest {
  component: 'backend';
  version: string;
  releasedAt: string;
  downloadUrl: string;
  sha256: string;
  minCompatibleVersion?: string;
  changelog: string;
  requiresMigration?: boolean;
  extraWarning?: string;
  signature: string;
}

export function updatesRouter(requireAdmin: RequestHandler): Router {
  const router = Router();

  // =====================================================================
  // فرونت إند (Tauri) — نظام tauri-plugin-updater / minisign
  // =====================================================================

  // ---------- تطبيق سطح المكتب للعميل (عام — بدون تسجيل دخول) ----------
  // بيتنادى تلقائيًا من @tauri-apps/plugin-updater حسب الرابط المضبوط في
  // tauri.conf.json (plugins.updater.endpoints)، بنفس تنسيق Tauri الرسمي:
  //   GET /frontend/:target/:arch/:currentVersion
  // لازم يرجّع 204 (من غير body) لو مفيش تحديث أحدث، أو 200 + manifest.

  router.get('/frontend/:target/:arch/:currentVersion', async (req, res) => {
    try {
      const { target, arch, currentVersion } = req.params;
      const platformKey = `${target}-${arch}`; // مثال: windows-x86_64

      const latest = await prisma.appRelease.findFirst({
        where: { target: 'frontend', enabled: true },
        orderBy: { pubDate: 'desc' },
      });

      if (!latest) return res.status(204).send();

      const platforms = latest.platforms as Record<string, { signature: string; url: string }>;
      const platformInfo = platforms[platformKey];

      // مفيش نسخة موقّعة للمنصة دي، أو النسخة الحالية أحدث أو نفس الأخيرة
      if (!platformInfo || !isNewerVersion(latest.version, currentVersion)) {
        return res.status(204).send();
      }

      return res.json({
        version: latest.version,
        notes: latest.notes ?? '',
        pub_date: latest.pubDate.toISOString(),
        platforms: { [platformKey]: platformInfo },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'حدث خطأ غير متوقع' });
    }
  });

  // ---------- إدارة (محمي بتسجيل دخول الأدمن) ----------

  router.get('/frontend', requireAdmin, async (_req, res) => {
    const releases = await prisma.appRelease.findMany({
      where: { target: 'frontend' },
      orderBy: { pubDate: 'desc' },
    });
    res.json(releases);
  });

  /**
   * تسجيل إصدار جديد بعد ما تبنيه وتوقّعه وترفعه على GitHub Releases (شوف
   * scripts/release-frontend.js في مشروع الفرونت إند). الجسم المتوقع:
   * { version, notes?, platforms: { "windows-x86_64": { signature, url } } }
   */
  router.post('/frontend', requireAdmin, async (req, res) => {
    const { version, notes, platforms } = req.body ?? {};
    if (!version || !platforms || typeof platforms !== 'object') {
      return res.status(400).json({ message: 'version و platforms مطلوبين' });
    }

    const existing = await prisma.appRelease.findUnique({
      where: { target_version: { target: 'frontend', version } },
    });
    if (existing) {
      return res.status(400).json({ message: `الإصدار ${version} مسجّل بالفعل` });
    }

    const release = await prisma.appRelease.create({
      data: { target: 'frontend', version, notes, platforms },
    });
    res.status(201).json(release);
  });

  /** مفتاح إيقاف فوري — لو ظهرت مشكلة في إصدار بعد نشره */
  router.patch('/frontend/:id/toggle', requireAdmin, async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled (true/false) مطلوب' });
    }
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release) return res.status(404).json({ message: 'الإصدار غير موجود' });

    const updated = await prisma.appRelease.update({
      where: { id: release.id },
      data: { enabled },
    });
    res.json(updated);
  });

  /** تعديل وصف الإصدار (اللي بيظهر للعميل في نافذة التحديث) — للفرونت إند بس */
  router.patch('/frontend/:id/notes', requireAdmin, async (req, res) => {
    const { notes } = req.body ?? {};
    if (typeof notes !== 'string') {
      return res.status(400).json({ message: 'notes (نص) مطلوب' });
    }
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release || release.target !== 'frontend') {
      return res.status(404).json({ message: 'الإصدار غير موجود' });
    }
    const updated = await prisma.appRelease.update({
      where: { id: release.id },
      data: { notes: notes.trim() },
    });
    res.json(updated);
  });

  router.delete('/frontend/:id', requireAdmin, async (req, res) => {
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release) return res.status(404).json({ message: 'الإصدار غير موجود' });

    await prisma.appRelease.delete({ where: { id: release.id } });
    res.status(204).send();
  });

  // =====================================================================
  // باك إند (سيرفر العيادة) — نظام Ed25519 المخصص (update-signature.util.ts)
  // نفس جدول AppRelease (target='backend')، بس هنا التوقيع بيتعمل محليًا
  // على جهاز المطوّر وقت النشر، ومش بيتم التحقق منه هنا — الباك إند نفسه
  // هو اللي بيتحقق من التوقيع لحظة الفحص (checkForUpdate) بمفتاحه العام.
  // license-server دوره بس تخزين وتقديم آخر manifest موقّع كما هو.
  // =====================================================================

  // ---------- سيرفر العيادة (عام — بدون تسجيل دخول) ----------
  // بيتنادى من UpdatesService.checkForUpdate() كل 6 ساعات، أو عند "تحقق الآن":
  //   GET {UPDATE_SERVER_URL}/backend/latest.json
  // لازم يرجّع 200 + الـ manifest الموقّع كامل، أو 404 لو مفيش إصدار منشور.

  router.get('/backend/latest.json', async (_req, res) => {
    try {
      const latest = await prisma.appRelease.findFirst({
        where: { target: 'backend', enabled: true },
        orderBy: { pubDate: 'desc' },
      });

      if (!latest) {
        return res.status(404).json({ message: 'لا يوجد إصدار خلفية منشور بعد' });
      }

      // الـ manifest الموقّع كامل مخزّن كما هو في platforms — بيترجع زي ما اتنشر بالظبط
      const manifest = latest.platforms as unknown as BackendManifest;
      return res.status(200).json(manifest);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'حدث خطأ غير متوقع' });
    }
  });

  // ---------- إدارة (محمي بتسجيل دخول الأدمن) ----------

  router.get('/backend', requireAdmin, async (_req, res) => {
    const releases = await prisma.appRelease.findMany({
      where: { target: 'backend' },
      orderBy: { pubDate: 'desc' },
    });
    res.json(releases);
  });

  /**
   * تسجيل إصدار باك إند جديد. الجسم المتوقع هو الـ manifest **الموقّع بالفعل**
   * (بمفتاح Ed25519 المحلي الخاص بالتحديثات، منفصل عن مفتاح التراخيص) — أي:
   * { component: 'backend', version, releasedAt, downloadUrl, sha256,
   *   changelog, minCompatibleVersion?, requiresMigration?, extraWarning?,
   *   signature }
   * license-server هنا ما بيوقّعش ولا بيتحقق — بس بيخزّن الـ manifest كما هو.
   */
  router.post('/backend', requireAdmin, async (req, res) => {
    const manifest = req.body as Partial<BackendManifest>;
    const required: (keyof BackendManifest)[] = [
      'version',
      'releasedAt',
      'downloadUrl',
      'sha256',
      'changelog',
      'signature',
    ];
    const missing = required.filter((key) => !manifest[key]);
    if (missing.length > 0) {
      return res.status(400).json({ message: `حقول ناقصة: ${missing.join(', ')}` });
    }

    const existing = await prisma.appRelease.findUnique({
      where: { target_version: { target: 'backend', version: manifest.version! } },
    });
    if (existing) {
      return res.status(400).json({ message: `الإصدار ${manifest.version} مسجّل بالفعل` });
    }

    const fullManifest: BackendManifest = {
      component: 'backend',
      version: manifest.version!,
      releasedAt: manifest.releasedAt!,
      downloadUrl: manifest.downloadUrl!,
      sha256: manifest.sha256!,
      changelog: manifest.changelog!,
      minCompatibleVersion: manifest.minCompatibleVersion,
      requiresMigration: manifest.requiresMigration ?? false,
      extraWarning: manifest.extraWarning,
      signature: manifest.signature!,
    };

    const release = await prisma.appRelease.create({
      data: {
        target: 'backend',
        version: fullManifest.version,
        notes: fullManifest.changelog,
        platforms: fullManifest as any,
        pubDate: new Date(fullManifest.releasedAt),
      },
    });
    res.status(201).json(release);
  });

  /** مفتاح إيقاف فوري — لو ظهرت مشكلة في إصدار باك إند بعد نشره */
  router.patch('/backend/:id/toggle', requireAdmin, async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled (true/false) مطلوب' });
    }
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release) return res.status(404).json({ message: 'الإصدار غير موجود' });

    const updated = await prisma.appRelease.update({
      where: { id: release.id },
      data: { enabled },
    });
    res.json(updated);
  });

  router.delete('/backend/:id', requireAdmin, async (req, res) => {
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release) return res.status(404).json({ message: 'الإصدار غير موجود' });

    await prisma.appRelease.delete({ where: { id: release.id } });
    res.status(204).send();
  });


  // =====================================================================
  // SanaSoftware POS (Res&Cafe) — نفس فكرة الباك إند: manifest موقّع محليًا (Ed25519)
  // والتطبيق نفسه هو اللي بيتحقق من التوقيع بمفتاحه العام. target='POS' في جدول
  // AppRelease علشان ما يتلخبطش مع إصدارات العيادة (frontend / backend).
  // =====================================================================

  interface PosManifest {
    component: 'POS';
    version: string;
    releasedAt: string;
    downloadUrl: string;
    sha256: string;
    minCompatibleVersion?: string;
    changelog: string;
    requiresMigration?: boolean;
    extraWarning?: string;
    signature: string;
  }

  // عام — بيتنادى من التطبيق: 200 + الـ manifest الموقّع، أو 404 لو مفيش إصدار منشور
  router.get('/POS/latest.json', async (_req, res) => {
    try {
      const latest = await prisma.appRelease.findFirst({
        where: { target: 'POS', enabled: true },
        orderBy: { pubDate: 'desc' },
      });
      if (!latest) return res.status(404).json({ message: 'لا يوجد إصدار منشور بعد' });
      return res.status(200).json(latest.platforms);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: 'حدث خطأ غير متوقع' });
    }
  });

  router.get('/POS', requireAdmin, async (_req, res) => {
    const releases = await prisma.appRelease.findMany({
      where: { target: 'POS' },
      orderBy: { pubDate: 'desc' },
    });
    res.json(releases);
  });

  /** يستقبل الـ manifest الموقّع بالفعل (سكريبت scripts/publish-update-manifest.cjs في مشروع الـ POS) */
  router.post('/POS', requireAdmin, async (req, res) => {
    const manifest = req.body as Partial<PosManifest>;
    const required: (keyof PosManifest)[] = [
      'version',
      'releasedAt',
      'downloadUrl',
      'sha256',
      'changelog',
      'signature',
    ];
    const missing = required.filter((key) => !manifest[key]);
    if (manifest.component !== 'POS') missing.push('component' as keyof PosManifest);
    if (missing.length > 0) {
      return res.status(400).json({ message: `حقول ناقصة أو غير صحيحة: ${missing.join(', ')}` });
    }

    const existing = await prisma.appRelease.findUnique({
      where: { target_version: { target: 'POS', version: manifest.version! } },
    });
    if (existing) {
      return res.status(400).json({ message: `الإصدار ${manifest.version} مسجّل بالفعل` });
    }

    // بيتخزّن كما وصل بالظبط (من غير إعادة ترتيب) — التوقيع على نفس الحقول
    const release = await prisma.appRelease.create({
      data: {
        target: 'POS',
        version: manifest.version!,
        notes: manifest.changelog,
        platforms: manifest as any,
        pubDate: new Date(manifest.releasedAt!),
      },
    });
    res.status(201).json(release);
  });

  /** مفتاح إيقاف فوري لإصدار الـ POS */
  router.patch('/POS/:id/toggle', requireAdmin, async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled (true/false) مطلوب' });
    }
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release || release.target !== 'POS') {
      return res.status(404).json({ message: 'الإصدار غير موجود' });
    }
    const updated = await prisma.appRelease.update({ where: { id: release.id }, data: { enabled } });
    res.json(updated);
  });

  router.delete('/POS/:id', requireAdmin, async (req, res) => {
    const release = await prisma.appRelease.findUnique({ where: { id: req.params.id } });
    if (!release || release.target !== 'POS') {
      return res.status(404).json({ message: 'الإصدار غير موجود' });
    }
    await prisma.appRelease.delete({ where: { id: release.id } });
    res.status(204).send();
  });

  return router;
}
