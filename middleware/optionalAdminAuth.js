const { requireAdminAuth } = require('./adminAuth');

// Best-effort admin auth: if credentials are present and valid, sets req.admin.
// If missing/invalid, continues as anonymous.
function optionalAdminAuth(req, res, next) {
  const authHeader = String(req.headers['authorization'] || '');
  const hasBearer = authHeader.toLowerCase().startsWith('bearer ');
  const cookieHeader = String(req.headers.cookie || '');
  const hasAnyCookie = cookieHeader.includes('np_admin') || cookieHeader.includes('np_admin_token') || cookieHeader.includes('np_admin_access');

  if (!hasBearer && !hasAnyCookie) return next();

  // Call requireAdminAuth but swallow auth errors.
  return requireAdminAuth(
    req,
    {
      status: () => ({ json: () => next() }),
      json: () => next(),
    },
    next
  );
}

module.exports = { optionalAdminAuth };
