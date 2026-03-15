function _isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function _parseLegacyDmyHm(s) {
  // Legacy admin format: "DD-MM-YYYY HH:mm" (optionally with seconds)
  // Example: "15-03-2026 22:29"
  const m = /^\s*(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(String(s || ''));
  if (!m) return null;

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const HH = m[4] != null ? Number(m[4]) : 0;
  const MM = m[5] != null ? Number(m[5]) : 0;
  const SS = m[6] != null ? Number(m[6]) : 0;

  if (!Number.isInteger(dd) || dd < 1 || dd > 31) return null;
  if (!Number.isInteger(mm) || mm < 1 || mm > 12) return null;
  if (!Number.isInteger(yyyy) || yyyy < 1970 || yyyy > 9999) return null;
  if (!Number.isInteger(HH) || HH < 0 || HH > 23) return null;
  if (!Number.isInteger(MM) || MM < 0 || MM > 59) return null;
  if (!Number.isInteger(SS) || SS < 0 || SS > 59) return null;

  const d = new Date(yyyy, mm - 1, dd, HH, MM, SS, 0);
  // Guard against overflows like 32-01-2026
  if (d.getFullYear() !== yyyy || d.getMonth() !== (mm - 1) || d.getDate() !== dd) return null;
  return d;
}

function parseDateMaybe(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, date: null, reason: 'empty' };
  }

  if (_isValidDate(value)) return { ok: true, date: value, reason: 'date' };

  // Allow epoch millis
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (_isValidDate(d)) return { ok: true, date: d, reason: 'epoch_ms' };
  }

  const s = String(value).trim();
  if (!s) return { ok: true, date: null, reason: 'empty_string' };

  // First try ISO-ish parsing (supports timezone offsets)
  const iso = new Date(s);
  if (_isValidDate(iso)) return { ok: true, date: iso, reason: 'iso' };

  const legacy = _parseLegacyDmyHm(s);
  if (_isValidDate(legacy)) return { ok: true, date: legacy, reason: 'legacy_dmy_hm' };

  return { ok: false, date: null, reason: 'unparseable' };
}

module.exports = {
  parseDateMaybe,
};
