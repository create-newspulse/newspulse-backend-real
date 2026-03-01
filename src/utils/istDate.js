const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

function _pad2(n) {
  return String(n).padStart(2, '0');
}

function isValidIstDateKey(dateKey) {
  return typeof dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

function getIstDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;

  // India Standard Time is fixed at UTC+05:30.
  // Shift timestamp by +05:30 and then read the UTC calendar date.
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return `${y}-${_pad2(m)}-${_pad2(day)}`;
}

function parseIstDateKey(dateKey) {
  if (!isValidIstDateKey(dateKey)) return null;
  const [y, m, d] = dateKey.split('-').map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return { year: y, month: m, day: d };
}

function getIstDayRangeUtc(dateKey) {
  const parsed = parseIstDateKey(dateKey);
  if (!parsed) return null;

  const { year, month, day } = parsed;
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - IST_OFFSET_MS;
  const startUtc = new Date(startUtcMs);
  const endUtc = new Date(startUtcMs + 24 * 60 * 60 * 1000);
  return { dateKey, startUtc, endUtc };
}

function formatIstTimeText(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);

  let hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${hours}:${_pad2(minutes)} ${ampm}`;
}

module.exports = {
  IST_OFFSET_MINUTES,
  isValidIstDateKey,
  getIstDateKey,
  parseIstDateKey,
  getIstDayRangeUtc,
  formatIstTimeText,
};
