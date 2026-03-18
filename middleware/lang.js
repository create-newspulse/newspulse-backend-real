function normalizeLanguage(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  // Native script hints (common for user-facing language labels)
  // Gujarati block: U+0A80..U+0AFF, Devanagari: U+0900..U+097F
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;

  // Common labels/aliases (UI often sends these)
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
}

// Determines requested language without forcing a default (controllers may choose defaults).
function langMiddleware(req, _res, next) {
  const queryLang = normalizeLanguage(req.query && (req.query.lang ?? req.query.language));
  const headerLang = normalizeLanguage(req.headers && (req.headers['x-lang'] || req.headers['x-language']));
  const requestedLang = queryLang || headerLang || null;

  req.lang = requestedLang;
  req.langResolved = requestedLang || 'en';
  next();
}

module.exports = {
  langMiddleware,
  normalizeLanguage,
};
