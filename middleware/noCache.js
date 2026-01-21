// middleware/noCache.js
module.exports = function noCache(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};
