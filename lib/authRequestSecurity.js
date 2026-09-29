const { buildAllowedCorsOrigins, isLocalDevelopmentLike, isLocalOrigin } = require('./environmentSafety');

const attempts = new Map();
const windowMs = 15 * 60 * 1000;

function rejectUnsafeCookieAuth(req, res, explicitCredential = false) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (explicitCredential || /^Bearer\s+\S+/i.test(req.headers.authorization || '')) return false;
  if (!/(?:^|;\s*)(?:token|np_token|np_admin_token|np_refresh_token)=/.test(req.headers.cookie || '')) return false;
  const origin = String(req.headers.origin || '');
  const allowed = buildAllowedCorsOrigins(process.env).includes(origin)
    || (isLocalDevelopmentLike() && isLocalOrigin(origin));
  if (origin && allowed) return false;
  res.status(403).json({ ok: false, code: 'CSRF_ORIGIN_REQUIRED', message: 'Trusted Origin required for cookie authentication' });
  return true;
}

function protectAuthRequest(req, res, operation) {
  res.set('Cache-Control', 'no-store');
  if (rejectUnsafeCookieAuth(req, res, operation === 'refresh' && Boolean(req.body?.refreshToken))) return false;
  const now = Date.now();
  for (const [key, entry] of attempts) if (now - entry.startedAt >= windowMs) attempts.delete(key);
  const key = operation + ':' + (req.ip || req.socket?.remoteAddress || 'unknown');
  const entry = attempts.get(key) || { startedAt: now, count: 0 };
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count <= (operation === 'refresh' ? 120 : 30)) return true;
  res.set('Retry-After', String(Math.ceil((windowMs - (now - entry.startedAt)) / 1000)));
  res.status(429).json({ ok: false, code: 'AUTH_RATE_LIMITED', message: 'Too many authentication attempts' });
  return false;
}

module.exports = { rejectUnsafeCookieAuth, protectAuthRequest };