const express = require('express');

const indiaStatesUTs = require('../src/constants/indiaStatesUTs');

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
  });
});

// India states/UTs master list
// - GET /api/meta/india-states-uts
// - GET /admin-api/meta/india-states-uts
router.get('/meta/india-states-uts', (_req, res) => {
  return res.json({
    success: true,
    items: Array.isArray(indiaStatesUTs) ? indiaStatesUTs : [],
  });
});

module.exports = router;
