const express = require('express');
const mongoose = require('mongoose');

const News = require('../models/News');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { generateArticleTranslations } = require('../services/articleTranslationGeneration.service');

const router = express.Router();

function isDbReady() {
  // In test/import mode, server intentionally skips Mongo connection.
  // Allow stubbing model methods in tests.
  return (mongoose.connection && mongoose.connection.readyState === 1) || String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

// POST /api/admin/news/:id/generate-translations
// Creates missing EN/HI/GU docs linked via translationKey.
router.post('/:id/generate-translations', requireAdminAuth, async (req, res) => {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, success: false, message: 'Database unavailable' });
    }

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid id' });
    }

    const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing GOOGLE_TRANSLATE_API_KEY' });
    }

    const sourceDoc = await News.findById(id);
    if (!sourceDoc) {
      return res.status(404).json({ ok: false, success: false, message: 'News not found' });
    }

    const result = await generateArticleTranslations(sourceDoc, {
      req,
      targetLanguages: req.body?.targetLanguages,
      overwrite: req.body?.overwrite === true,
      confirmOverwriteHumanEdited: req.body?.confirmOverwriteHumanEdited === true,
    });

    return res.status(200).json({
      ok: true,
      success: true,
      translationKey: result.translationGroupId,
      translationGroupId: result.translationGroupId,
      sourceLanguage: result.sourceLanguage,
      targetLanguages: result.targetLanguages,
      status: result.status,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      jobId: result.jobId,
    });
  } catch (e) {
    console.error('[adminNews.generate-translations] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to generate translations' });
  }
});

module.exports = router;
