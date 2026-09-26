function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.statusCode = 400;
  return error;
}

function safeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid author snapshot');
  const snapshot = {};
  for (const [field, limit] of Object.entries({ name: 160, publicDesignation: 160, photoUrl: 2048, shortBio: 600 })) {
    const text = value[field];
    if (text === undefined || text === null || text === '') continue;
    if (typeof text !== 'string' || text.trim().length > limit) throw invalid(`Invalid author byline ${field}`);
    if (text.trim()) snapshot[field] = text.trim();
  }
  if (!snapshot.name) throw invalid('Author byline name is required');
  if (snapshot.photoUrl) {
    let url;
    try { url = new URL(snapshot.photoUrl, 'https://byline.invalid'); } catch (_) { throw invalid('Invalid author photo URL'); }
    const localUpload = snapshot.photoUrl.startsWith('/uploads/')
      && url.origin === 'https://byline.invalid' && url.pathname.startsWith('/uploads/')
      && !/[\\\s%?#]/.test(snapshot.photoUrl) && !snapshot.photoUrl.split('/').some((part) => part === '.' || part === '..');
    const secureUrl = /^https:\/\//i.test(snapshot.photoUrl) && url.protocol === 'https:' && !/[\\\s]/.test(snapshot.photoUrl);
    if ((!localUpload && !secureUrl) || url.username || url.password) throw invalid('Author photo must be an HTTPS URL without credentials or an /uploads/ path');
  }
  return snapshot;
}

async function buildAuthorBylinePatch(body, existing = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, 'authorByline')) return undefined;
  const input = body.authorByline;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Invalid authorByline');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw invalid('authorByline.enabled must be boolean');
  const previous = existing.authorByline;
  const enabled = input.enabled ?? previous?.enabled ?? false;
  if (!enabled) return { enabled: false };
  if (String(existing.category || '').toLowerCase() === 'pulse-dialogue') throw invalid('Author bylines are separate from Pulse Dialogue');
  const snapshot = safeSnapshot(input.snapshot === undefined ? previous?.snapshot : input.snapshot);
  const unchanged = previous?.enabled && JSON.stringify(snapshot) === JSON.stringify(safeSnapshot(previous.snapshot));
  return {
    enabled: true,
    snapshot,
    ...(unchanged && previous.snapshotCapturedAt ? { snapshotCapturedAt: previous.snapshotCapturedAt }
      : existing.status === 'published' ? { snapshotCapturedAt: new Date() } : {}),
  };
}

async function prepareAuthorBylineForPublication(doc, now = new Date()) {
  const byline = doc.authorByline;
  if (!byline?.enabled) return;
  if (String(doc.category || '').toLowerCase() === 'pulse-dialogue') throw invalid('Author bylines are separate from Pulse Dialogue');
  doc.authorByline = {
    enabled: true,
    snapshot: safeSnapshot(byline.snapshot),
    snapshotCapturedAt: byline.snapshotCapturedAt || now,
  };
}

function publicAuthorByline(value) {
  if (value?.enabled !== true) return undefined;
  try {
    return { enabled: true, snapshot: safeSnapshot(value.snapshot) };
  } catch (_) {
    return undefined;
  }
}

function withPublicAuthorByline(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = { ...doc };
  const byline = publicAuthorByline(doc.authorByline);
  delete out.authorByline;
  if (byline && String(doc.category || '').toLowerCase() !== 'pulse-dialogue') out.authorByline = byline;
  return out;
}

module.exports = { buildAuthorBylinePatch, prepareAuthorBylineForPublication, publicAuthorByline, withPublicAuthorByline };