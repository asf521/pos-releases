import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || '';
const TOKEN_TTL = '12h';

if (!JWT_SECRET) {
  // متعمد: نوقف السيرفر بدل ما يشتغل بمفتاح فاضي غير آمن
  throw new Error('لازم تحط JWT_SECRET في .env قبل تشغيل السيرفر');
}

/**
 * سيرفر التراخيص ده أداة إدارة داخلية بتاعتك إنت بس (المُورِّد)، مش نظام
 * متعدد المستخدمين. عشان كده مفيش جدول Users ولا RBAC — يوزر أدمن واحد بس
 * بياناته في .env (ADMIN_USERNAME / ADMIN_PASSWORD). لو محتاج أكتر من شخص
 * يدير التراخيص لاحقًا، ده أول حاجة تتوسّع فيها.
 */
export function loginHandler(req: Request, res: Response) {
  const { username, password } = req.body ?? {};

  const validUsername = process.env.ADMIN_USERNAME;
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validUsername || !validPassword) {
    return res.status(500).json({ message: 'ADMIN_USERNAME / ADMIN_PASSWORD غير مضبوطين في .env' });
  }

  if (username !== validUsername || password !== validPassword) {
    return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  const token = jwt.sign({ sub: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.json({ accessToken: token });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'محتاج تسجيل دخول' });
  }
  try {
    jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'جلسة الدخول غير صالحة أو منتهية' });
  }
}
