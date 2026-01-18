function _normalizeCompare(s) {
  return String(s || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function _countMatches(text, re) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function _scriptStats(text) {
  const t = String(text || '');
  const latin = _countMatches(t, /[A-Za-z]/g);
  const devanagari = _countMatches(t, /[\u0900-\u097F]/g);
  const gujarati = _countMatches(t, /[\u0A80-\u0AFF]/g);
  const total = latin + devanagari + gujarati;
  return { latin, devanagari, gujarati, total };
}

function looksLikeTargetLang(text, targetLang) {
  const t = String(text || '').trim();
  if (!t) return false;

  const lang = String(targetLang || '').trim().toLowerCase();
  const { latin, devanagari, gujarati, total } = _scriptStats(t);
  if (total === 0) {
    // Numbers/punctuation only: treat as low-confidence.
    return false;
  }

  if (lang === 'hi') {
    return devanagari >= 2 && (devanagari / total) >= 0.35;
  }

  if (lang === 'gu') {
    return gujarati >= 2 && (gujarati / total) >= 0.35;
  }

  if (lang === 'en') {
    return latin >= 2 && (latin / total) >= 0.55;
  }

  return false;
}

function shouldAcceptTranslation(inputText, outputText, sourceLang, targetLang) {
  const src = String(sourceLang || '').trim().toLowerCase();
  const dst = String(targetLang || '').trim().toLowerCase();

  const inputNorm = _normalizeCompare(inputText);
  const outputNorm = _normalizeCompare(outputText);

  if (!outputNorm) return false;

  // For en/hi/gu we should usually not accept identical output when translating.
  if (src && dst && src !== dst && inputNorm && outputNorm && inputNorm === outputNorm) {
    return false;
  }

  // Script heuristic.
  if (dst === 'en' || dst === 'hi' || dst === 'gu') {
    if (!looksLikeTargetLang(outputNorm, dst)) return false;
  }

  return true;
}

module.exports = {
  looksLikeTargetLang,
  shouldAcceptTranslation,
};
