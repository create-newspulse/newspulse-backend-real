function _escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _isPlaceholderToken(tok) {
  const t = String(tok || '');
  return /^__LOCK_\d+__$/.test(t) || /^__ENT_\d+__$/.test(t);
}

function extractEntities(text, options = {}) {
  const orgSuffixes = Array.isArray(options.orgSuffixes) ? options.orgSuffixes : [
    'Ltd', 'Inc', 'Corp', 'Pvt', 'LLP', 'BJP', 'INC', 'AAP', 'CEO', 'CFO', 'IAS', 'IPS',
  ];

  const s = String(text || '');
  const entities = new Set();

  // ALL CAPS abbreviations
  for (const m of s.matchAll(/\b[A-Z]{2,}\b/g)) {
    entities.add(m[0]);
  }

  // English capitalized sequences (two or more words)
  for (const m of s.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)) {
    entities.add(m[0]);
  }

  // Org suffix patterns
  for (const suf of orgSuffixes) {
    const re = new RegExp(`\\b[\\p{L}0-9&.\\-]+\\s+${_escapeRegex(suf)}\\b`, 'giu');
    for (const m of s.matchAll(re)) {
      entities.add(m[0]);
    }
  }

  const list = Array.from(entities)
    .map(v => String(v).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  return list;
}

function lockEntities(text, entities) {
  let out = String(text || '');
  const map = [];

  const list = Array.isArray(entities) ? entities : [];
  for (const ent of list) {
    if (!ent) continue;

    // Avoid re-locking placeholders
    if (_isPlaceholderToken(ent)) continue;

    const placeholder = `__ENT_${map.length}__`;
    map.push({ placeholder, value: ent });

    const re = new RegExp(_escapeRegex(ent), 'g');
    out = out.replace(re, placeholder);
  }

  return { text: out, entities: map };
}

function restoreEntities(text, entityMap) {
  let out = String(text || '');
  for (const e of Array.isArray(entityMap) ? entityMap : []) {
    if (!e || !e.placeholder) continue;
    out = out.split(String(e.placeholder)).join(String(e.value));
  }
  return out;
}

module.exports = { extractEntities, lockEntities, restoreEntities };
