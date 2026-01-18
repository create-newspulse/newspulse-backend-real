function _collapseSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function applyHindiStyle(text) {
  let out = _collapseSpaces(text);
  out = out.replace(/\s+([,.;!?])/g, '$1');
  out = out.replace(/([,.;!?])(?=\S)/g, '$1 ');
  // Prefer danda at end of sentences when a period is used.
  out = out.replace(/\.(\s|$)/g, '।$1');
  out = out.replace(/\s+।/g, '।');
  return out.trim();
}

function applyGujaratiStyle(text) {
  let out = _collapseSpaces(text);
  out = out.replace(/\s+([,.;!?])/g, '$1');
  out = out.replace(/([,.;!?])(?=\S)/g, '$1 ');
  // Avoid forcing danda: Gujarati often uses '.'; keep simple normalization.
  return out.trim();
}

function applyStylePack(text, targetLang) {
  const lang = String(targetLang || '').trim().toLowerCase();
  if (lang === 'hi') return applyHindiStyle(text);
  if (lang === 'gu') return applyGujaratiStyle(text);
  return _collapseSpaces(text);
}

module.exports = { applyStylePack };
