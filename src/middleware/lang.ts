export type Lang = 'en' | 'hi' | 'gu';

export function normalizeLanguage(v: unknown): Lang | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s as Lang;
  return null;
}

// Runtime middleware lives in middleware/lang.js; this is a typed mirror.
export function langMiddleware(req: any, _res: any, next: any) {
  const queryLang = normalizeLanguage(req?.query?.lang ?? req?.query?.language);
  const headerLang = normalizeLanguage(req?.headers?.['x-lang'] ?? req?.headers?.['x-language']);
  const requestedLang = queryLang || headerLang || null;

  req.lang = requestedLang;
  req.langResolved = requestedLang || 'en';
  next();
}
