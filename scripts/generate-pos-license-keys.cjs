#!/usr/bin/env node
/**
 * بيولّد زوج مفاتيح Ed25519 لتوقيع تراخيص SanaSoftware POS (منفصل تمامًا عن مفاتيح
 * العيادات ومفتاح التحديثات).
 *
 * الاستخدام (على جهازك، مرة واحدة بس):
 *   node scripts/generate-pos-license-keys.cjs
 *
 * الناتج في مجلد keys/ :
 *   pos-license-private.pem  ← سرّي. مايترفعش على GitHub. تحطه على Render (تحت).
 *   pos-license-public.pem   ← عام.
 *   license-public-key.ts    ← انسخه فوق main/license-public-key.ts في مشروع الـ POS.
 *
 * لو المفتاح موجود بالفعل السكريبت بيرفض يكتب فوقه (عشان ماتبوّظش تراخيص اتصدرت).
 * لو عايز تعمل مفتاح جديد فعلًا: --force (كل التراخيص القديمة هتبطل).
 */
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(process.cwd(), 'keys');
const privPath = path.join(dir, 'pos-license-private.pem');
const pubPath = path.join(dir, 'pos-license-public.pem');
const tsPath = path.join(dir, 'license-public-key.ts');

if (fs.existsSync(privPath) && !process.argv.includes('--force')) {
  console.error('❌ المفتاح موجود بالفعل: ' + privPath);
  console.error('   لو عايز تعمل مفتاح جديد فعلًا (هيبطّل كل التراخيص القديمة) استخدم --force');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem);
fs.writeFileSync(
  tsPath,
  '/** Public Ed25519 key used only to authenticate SanaSoftware POS license tokens. */\n' +
    'export const LICENSE_PUBLIC_KEY_PEM = `' + pubPem + '`;\n',
);

console.log('✅ تم توليد المفاتيح في: ' + dir);
console.log('');
console.log('1) في مشروع الـ POS: انسخ keys/license-public-key.ts فوق  main/license-public-key.ts');
console.log('2) على Render → Environment → أضف متغير جديد اسمه POS_LICENSE_PRIVATE_KEY وقيمته السطر ده بالكامل:');
console.log('');
console.log(privPem.trim().replace(/\r?\n/g, '\\n'));
console.log('');
console.log('3) احفظ نسخة من keys/pos-license-private.pem في مكان آمن (لو ضاعت مش هتقدر تصدر تراخيص بنفس المفتاح).');
