function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
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
