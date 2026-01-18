function normalizeForSimilarity(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardSimilarity(a, b) {
  const as = new Set(normalizeForSimilarity(a).split(' ').filter(Boolean));
  const bs = new Set(normalizeForSimilarity(b).split(' ').filter(Boolean));
  if (as.size === 0 && bs.size === 0) return 1;
  if (as.size === 0 || bs.size === 0) return 0;

  let inter = 0;
  for (const w of as) if (bs.has(w)) inter += 1;
  const union = as.size + bs.size - inter;
  return union === 0 ? 0 : inter / union;
}

function countLatinLetters(s) {
  const m = String(s || '').match(/[A-Za-z]/g);
  return m ? m.length : 0;
}

function qaCheckExpanded({ sourcePre, translatedPre, entityMap, strictMode, glossaryLockedTerms }) {
  const src = String(sourcePre && sourcePre.text ? sourcePre.text : '');
  const trg = String(translatedPre || '');

  const locks = Array.isArray(sourcePre && sourcePre.locks ? sourcePre.locks : []) ? sourcePre.locks : [];
  const ents = Array.isArray(entityMap) ? entityMap : [];

  const checks = {
    nonEmpty: trg.trim().length > 0,
    placeholdersPreserved: true,
    missingPlaceholders: [],
    entitiesPreserved: true,
    missingEntities: [],
    glossaryLockedPreserved: true,
    missingGlossaryLocked: [],
    latinLetters: countLatinLetters(trg),
    strictMode: Boolean(strictMode),
    backTranslationSimilarity: null,
  };

  for (const l of locks) {
    if (!l || !l.placeholder) continue;
    if (!trg.includes(String(l.placeholder))) {
      checks.placeholdersPreserved = false;
      checks.missingPlaceholders.push(String(l.placeholder));
    }
  }

  for (const e of ents) {
    if (!e || !e.placeholder) continue;
    if (!trg.includes(String(e.placeholder))) {
      checks.entitiesPreserved = false;
      checks.missingEntities.push(String(e.placeholder));
    }
  }

  const gl = Array.isArray(glossaryLockedTerms) ? glossaryLockedTerms : [];
  for (const term of gl) {
    if (!term) continue;
    if (!trg.includes(String(term))) {
      checks.glossaryLockedPreserved = false;
      checks.missingGlossaryLocked.push(String(term));
    }
  }

  checks.sourceLen = src.length;
  checks.translatedLen = trg.length;

  return checks;
}

function scoreTranslationExpanded(checks, targetLang) {
  let score = 100;

  if (!checks || typeof checks !== 'object') return 0;
  if (!checks.nonEmpty) score -= 60;
  if (!checks.placeholdersPreserved) score -= 30;
  if (!checks.entitiesPreserved) score -= 30;
  if (!checks.glossaryLockedPreserved) score -= 20;

  // Penalize extremely short outputs.
  if (typeof checks.translatedLen === 'number' && checks.translatedLen < 3) score -= 30;

  // Regional language: discourage heavy Latin script.
  const lang = String(targetLang || '').toLowerCase();
  if ((lang === 'hi' || lang === 'gu') && typeof checks.latinLetters === 'number') {
    if (checks.latinLetters > 25) score -= 15;
    if (checks.latinLetters > 60) score -= 25;
  }

  // Strict mode back-translation requirement (if computed).
  if (checks.strictMode && typeof checks.backTranslationSimilarity === 'number') {
    if (checks.backTranslationSimilarity < 0.85) score -= 25;
    if (checks.backTranslationSimilarity < 0.75) score -= 40;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
  normalizeForSimilarity,
  jaccardSimilarity,
  qaCheckExpanded,
  scoreTranslationExpanded,
};
