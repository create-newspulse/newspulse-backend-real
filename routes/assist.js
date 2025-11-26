const express = require('express');

// Compatibility stub for '/assist/suggest/v2' expected by some clients
// Keep lightweight to avoid external dependencies; duplicates are safe.
const router = express.Router();

router.post('/assist/suggest/v2', (req, res) => {
  const text = String(req.body?.text || req.body?.content || req.body?.summary || req.body?.title || '').trim();
  const title = text.split('\n')[0].slice(0, 100) || 'Draft headline suggestion';
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const summary = (text || 'Draft summary suggestion').slice(0, 160);
  return res.json({ ok: true, success: true, suggestions: { title, slug, summary } });
});

module.exports = router;
