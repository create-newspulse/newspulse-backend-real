function _normalizeString(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function _splitEmail(emailNorm) {
  const e = _normalizeString(emailNorm);
  if (!e) return null;
  const at = e.indexOf('@');
  if (at <= 0 || at === e.length - 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!local || !domain) return null;
  return { local, domain };
}

function isPlaceholderEmail(emailNorm) {
  const e = _normalizeString(emailNorm);
  if (!e) return false;

  const parts = _splitEmail(e);
  if (!parts) return true;

  const local = parts.local.toLowerCase();
  const domain = parts.domain.toLowerCase();

  // Hard block: clearly invalid/non-routable domains.
  if (domain === 'invalid' || domain === 'localhost') return true;

  // Specific known dummy addresses (avoid collapsing unrelated reporters).
  const explicit = new Set([
    'reporter@example.com',
    'user@example.com',
    'test@example.com',
    'demo@example.com',
    'anonymous@example.com',
  ]);
  if (explicit.has(e.toLowerCase())) return true;

  // Common dummy local-parts when paired with example.* domains.
  const exampleDomains = new Set(['example.com', 'example.org', 'example.net']);
  if (exampleDomains.has(domain)) {
    const dummyLocals = new Set(['reporter', 'user', 'test', 'demo', 'anonymous']);
    if (dummyLocals.has(local)) return true;
  }

  // No-reply inboxes are not reliable identity anchors.
  if (local.includes('noreply') || local.includes('no-reply')) return true;

  return false;
}

function normalizeEmailForIdentity(raw) {
  const e = _normalizeString(raw);
  if (!e) return null;
  const norm = e.toLowerCase();
  if (isPlaceholderEmail(norm)) return null;
  return norm;
}

function isPlaceholderPhone(phoneNorm) {
  const p = _normalizeString(phoneNorm);
  if (!p) return false;

  const digits = p.replace(/\D+/g, '');
  if (!digits) return true;

  // Too short to be meaningful.
  if (digits.length < 6) return true;

  // Obvious dummy sequences (check both full digits and suffix, to catch +91 prefix).
  const blocked = [
    '000000',
    '0000000',
    '00000000',
    '000000000',
    '0000000000',
    '111111',
    '1111111',
    '11111111',
    '111111111',
    '1111111111',
    '123456',
    '1234567',
    '12345678',
    '123456789',
    '1234567890',
    '999999',
    '9999999',
    '99999999',
    '999999999',
    '9999999999',
  ];
  if (blocked.includes(digits)) return true;
  for (const b of blocked) {
    if (digits.length > b.length && digits.endsWith(b)) return true;
  }

  // All digits the same.
  if (/^(\d)\1+$/.test(digits)) return true;

  return false;
}

function normalizePhoneForIdentity(raw) {
  const input = _normalizeString(raw);
  if (!input) return null;

  const plus = input.startsWith('+') ? '+' : '';
  const digits = input.replace(/\D+/g, '');
  const out = plus ? `+${digits}` : digits;
  if (!out) return null;
  if (isPlaceholderPhone(out)) return null;
  return out;
}

function normalizePersonNameKey(raw) {
  const s = _normalizeString(raw);
  if (!s) return null;
  const lowered = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!lowered || lowered === 'unknown' || lowered === 'unknown reporter') return null;
  return lowered;
}

function parseLooseLocationString(input) {
  const s = _normalizeString(input);
  if (!s) return { city: null, state: null, country: null };

  const parts = s
    .split(',')
    .map((x) => String(x).trim())
    .filter(Boolean);

  return {
    city: parts[0] || null,
    state: parts[1] || null,
    country: parts[2] || null,
  };
}

module.exports = {
  isPlaceholderEmail,
  normalizeEmailForIdentity,
  isPlaceholderPhone,
  normalizePhoneForIdentity,
  normalizePersonNameKey,
  parseLooseLocationString,
};
