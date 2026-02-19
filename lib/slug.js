function safeDecodeURIComponent(value) {
  const s = String(value ?? '');
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function normalizeSlugSimple(value) {
  return String(value ?? '').trim().toLowerCase();
}

function getSlugCandidates(value) {
  const raw = String(value ?? '').trim();

  // IMPORTANT:
  // - Never ONLY lowercase the raw value because it can contain percent-encoded
  //   bytes (e.g. %E0%A4%..) where hex casing may differ from what is stored.
  // - Include the exact raw form PLUS a lowercased variant (when different)
  //   to tolerate older inconsistent storage.
  // - Also include the decoded Unicode (lowercased) for canonical lookups.
  const decoded = safeDecodeURIComponent(raw);

  const out = [];
  if (raw) out.push(raw);

  const rawLower = raw.toLowerCase();
  if (rawLower && rawLower !== raw) out.push(rawLower);

  const decodedNorm = normalizeSlugSimple(decoded);
  if (decodedNorm && !out.includes(decodedNorm)) out.push(decodedNorm);

  return out;
}

function canonicalizeSlug(value) {
  const decoded = safeDecodeURIComponent(String(value ?? ''));
  return normalizeSlugSimple(decoded);
}

module.exports = {
  safeDecodeURIComponent,
  normalizeSlugSimple,
  getSlugCandidates,
  canonicalizeSlug,
};
