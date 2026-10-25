import { createPrivateKey, sign as edSign, KeyObject } from 'crypto';
import { readFileSync, existsSync } from 'fs';

/** المنتجات اللي السيرفر بيصدر لها تراخيص. 'clinic' = سنا سنتر (العيادات)، 'pos' = SanaSoftware POS. */
export type LicenseProduct = 'clinic' | 'pos';

export interface LicenseTokenPayload {
  licenseId: string;
  clientId: string;
  clientName?: string;
  type: 'trial' | 'premium' | 'full';
  maxDevices: number;
  features: string[];
  hardwareId: string;
  issuedAt: number;
  expiresAt: number;
  verifiedAt: number;
  /**
   * بيتحط فقط في توكن الـ POS. توكن العيادة بيفضل بنفس شكله القديم بالظبط
   * عشان تطبيق العيادة (Rust) مايتأثرش بأي حقل جديد.
   */
  product?: 'pos';
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cachedPrivateKeys: Partial<Record<LicenseProduct, KeyObject>> = {};

/**
 * مفتاح توقيع كل منتج منفصل:
 *  - clinic: ملف LICENSE_PRIVATE_KEY_PATH (أو keys/license-private.pem) — زي ما كان.
 *  - pos: متغير بيئة POS_LICENSE_PRIVATE_KEY (نص PEM، ممكن بـ \n حرفية) أو
 *    POS_LICENSE_PRIVATE_KEY_PATH أو keys/pos-license-private.pem.
 *    على Render (من غير ديسك دائم) استخدم المتغير.
 */
function loadPrivateKey(product: LicenseProduct): KeyObject {
  const cached = cachedPrivateKeys[product];
  if (cached) return cached;

  let key: KeyObject;

  if (product === 'pos') {
    const inline = process.env.POS_LICENSE_PRIVATE_KEY?.trim();
    if (inline) {
      key = createPrivateKey(inline.replace(/\\n/g, '\n'));
    } else {
      const keyPath =
        process.env.POS_LICENSE_PRIVATE_KEY_PATH || `${process.cwd()}/keys/pos-license-private.pem`;
      if (!existsSync(keyPath)) {
        throw new Error(
          'مفتاح توقيع تراخيص الـ POS غير مضبوط. شغّل: node scripts/generate-pos-license-keys.cjs ' +
            'وحط المفتاح الخاص في متغير POS_LICENSE_PRIVATE_KEY على Render.',
        );
      }
      key = createPrivateKey(readFileSync(keyPath, 'utf8'));
    }
  } else {
    const keyPath = process.env.LICENSE_PRIVATE_KEY_PATH || `${process.cwd()}/keys/license-private.pem`;
    if (!existsSync(keyPath)) {
      throw new Error(`ملف المفتاح الخاص غير موجود: ${keyPath}\nشغّل: npm run generate-keys`);
    }
    key = createPrivateKey(readFileSync(keyPath, 'utf8'));
  }

  cachedPrivateKeys[product] = key;
  return key;
}

export function signLicenseToken(payload: LicenseTokenPayload, product: LicenseProduct = 'clinic'): string {
  const key = loadPrivateKey(product);
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = edSign(null, payloadBuf, key);
  return `${b64url(payloadBuf)}.${b64url(signature)}`;
}
