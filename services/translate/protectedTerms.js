const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'protected-terms.json');

let _cache = null;
let _cacheMtimeMs = 0;

function _loadFile() {
  try {
    const stat = fs.statSync(DATA_PATH);
    const mtimeMs = stat.mtimeMs || 0;
    if (_cache && _cacheMtimeMs === mtimeMs) return _cache;

    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    const terms = Array.isArray(parsed?.terms) ? parsed.terms : [];
    const abbreviations = Array.isArray(parsed?.abbreviations) ? parsed.abbreviations : [];

    _cache = { terms, abbreviations };
    _cacheMtimeMs = mtimeMs;
    return _cache;
  } catch (_) {
    _cache = { terms: [], abbreviations: [] };
    _cacheMtimeMs = 0;
    return _cache;
  }
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _isAsciiWord(s) {
  return /^[A-Za-z0-9][A-Za-z0-9 .'-]*$/.test(String(s || ''));
}

function _compileSourceRegex(source) {
  const src = String(source || '').trim();
  if (!src) return null;

  // Use word boundaries for ASCII-ish sources, otherwise fall back to plain global replacement.
  if (_isAsciiWord(src)) {
    // For phrases with spaces, boundary-wrap the ends.
    return new RegExp(`\\b${_escapeRegex(src)}\\b`, 'g');
  }

  return new RegExp(_escapeRegex(src), 'g');
}

function applyProtectedTermsPre(text) {
  const { terms } = _loadFile();
  const raw = String(text || '');
  if (!raw.trim() || !terms.length) return { text: raw, tokenMap: new Map() };

  // Longest-first prevents partial replacement collisions.
  const sorted = terms
    .map(t => ({ source: String(t?.source || '').trim(), targets: t?.targets && typeof t.targets === 'object' ? t.targets : {} }))
    .filter(t => t.source)
    .sort((a, b) => b.source.length - a.source.length);

  let out = raw;
  const tokenMap = new Map();
  let idx = 0;

  for (const t of sorted) {
    const rx = _compileSourceRegex(t.source);
    if (!rx) continue;

    if (!rx.test(out)) continue;

    const token = `__PT_${idx}__`;
    idx++;

    // Reset lastIndex because we tested with /g.
    rx.lastIndex = 0;

    out = out.replace(rx, token);
    tokenMap.set(token, t);
  }

  return { text: out, tokenMap };
}

function applyProtectedTermsPost(text, tokenMap, targetLang) {
  let out = String(text || '');
  const lang = String(targetLang || '').trim().toLowerCase();
  if (!tokenMap || !(tokenMap instanceof Map) || tokenMap.size === 0) return out;

  for (const [token, t] of tokenMap.entries()) {
    const targets = t?.targets && typeof t.targets === 'object' ? t.targets : {};
    const replacement = typeof targets[lang] === 'string' && targets[lang].trim()
      ? String(targets[lang]).trim()
      : String(t?.source || '').trim();

    out = out.split(token).join(replacement);
  }

  return out;
}

function enforceProtectedTermsPostFix(text, targetLang) {
  const { terms } = _loadFile();
  let out = String(text || '');
  const lang = String(targetLang || '').trim().toLowerCase();
  if (!out.trim() || !terms.length) return out;

  // Replace any remaining occurrences of the English source with the target translation.
  const sorted = terms
    .map(t => ({ source: String(t?.source || '').trim(), targets: t?.targets && typeof t.targets === 'object' ? t.targets : {} }))
    .filter(t => t.source)
    .sort((a, b) => b.source.length - a.source.length);

  for (const t of sorted) {
    const targets = t.targets || {};
    const replacement = typeof targets[lang] === 'string' && targets[lang].trim()
      ? String(targets[lang]).trim()
      : String(t.source);

    const rx = _compileSourceRegex(t.source);
    if (!rx) continue;
    rx.lastIndex = 0;
    out = out.replace(rx, replacement);
  }

  return out;
}

function getAbbreviationsList() {
  const { abbreviations } = _loadFile();
  return Array.isArray(abbreviations) ? abbreviations.map(s => String(s || '').trim()).filter(Boolean) : [];
}

module.exports = {
  applyProtectedTermsPre,
  applyProtectedTermsPost,
  enforceProtectedTermsPostFix,
  getAbbreviationsList,
};
