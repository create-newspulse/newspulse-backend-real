const express = require('express');
const { LANGUAGE_VALUES } = require('../models/Article');

const router = express.Router();

function getSupportedLanguages() {
  // Keep this simple + stable for the admin UI.
  // If you later add more languages, append here.
  return [
    { code: 'en', name: 'English' },
    { code: 'hi', name: 'Hindi' },
    { code: 'gu', name: 'Gujarati' },
  ];
}

function getSupportedLanguageCodes() {
  // Prefer the canonical enum used by the public Article model.
  // Fallback to the platform contract if anything is unexpected.
  if (Array.isArray(LANGUAGE_VALUES) && LANGUAGE_VALUES.length) return [...LANGUAGE_VALUES];
  return ['en', 'hi', 'gu'];
}

// Admin UI bootstrap meta
// Common call-sites:
// - GET /api/admin/meta
// - GET /admin-api/admin/meta
router.get('/meta', (_req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    meta: {
      languages: getSupportedLanguages(),
      supportedLanguages: getSupportedLanguageCodes(),
      timestamp: new Date().toISOString(),
    },
  });
});

// Public-ish meta endpoint used by some admin builds:
// - GET /admin-api/meta/languages
// - GET /api/meta/languages (if mounted there)
router.get('/meta/languages', (_req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    languages: getSupportedLanguages(),
    supportedLanguages: getSupportedLanguageCodes(),
  });
});

// Minimal config endpoint for admin UI counters.
// - GET /api/admin/meta/supported-languages
// - GET /admin-api/meta/supported-languages
router.get('/meta/supported-languages', (_req, res) => {
  return res.json({
    ok: true,
    success: true,
    status: 200,
    supportedLanguages: getSupportedLanguageCodes(),
  });
});

module.exports = router;
