const express = require('express');

const { resolveRedirect } = require('../services/seoAuditService');

const router = express.Router();

router.get('/redirects/resolve', async (req, res) => {
  try {
    const redirect = await resolveRedirect(req.query.path || '/');
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, success: true, status: 200, ...redirect, redirect, data: { redirect } });
  } catch (error) {
    const status = Number(error?.status || 500);
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    return res.status(safeStatus).json({ ok: false, success: false, status: safeStatus, code: error?.code || 'SEO_REDIRECT_ERROR', message: error?.message || 'Unable to resolve SEO redirect.' });
  }
});

module.exports = router;