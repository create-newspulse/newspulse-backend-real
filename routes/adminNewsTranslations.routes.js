const express = require('express');
const mongoose = require('mongoose');

const News = require('../models/News');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { translateMany } = require('../services/translate/googleTranslateHelper');
const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');

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

function resolveSourceLang(doc) {
  return normalizeLanguage(doc?.lang) || normalizeLanguage(doc?.language) || 'gu';
}

async function translateField(text, sourceLang, targetLang) {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, text: null, error: 'Missing GOOGLE_TRANSLATE_API_KEY' };

  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: true, text: raw };

  const out = await translateMany([raw], targetLang);
  if (!out.ok) return { ok: false, text: null, error: out.error || 'Translate failed' };
  return { ok: true, text: out.items[0] };
}

function isPlainTextBody(content) {
  const s = String(content || '');
  if (!s.trim()) return true;
  return !/[<][^>]+[>]/.test(s);
}

function normalizeGroupKey(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function buildExistingQuery(groupKey, lang) {
  const lower = String(lang).toLowerCase();
  const upper = lower.toUpperCase();
  return {
    $and: [
      {
        $or: [
          { translationKey: groupKey },
          { translationGroupId: groupKey },
        ],
      },
      {
        $or: [
          { lang: { $in: [lower, upper] } },
          { language: { $in: [lower, upper] } },
        ],
      },
    ],
  };
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

    const existingKey = normalizeGroupKey(sourceDoc.translationKey) || normalizeGroupKey(sourceDoc.translationGroupId);
    const translationKey = existingKey || new mongoose.Types.ObjectId().toString();

    // Ensure source doc is linked.
    if (
      String(sourceDoc.translationKey || '') !== translationKey
      || String(sourceDoc.translationGroupId || '') !== translationKey
      || String(sourceDoc.sourceArticleId || '') !== String(sourceDoc._id || '')
    ) {
      await News.updateOne(
        { _id: id },
        { $set: { translationKey, translationGroupId: translationKey, sourceArticleId: sourceDoc._id } }
      );
    }

    const sourceLang = resolveSourceLang(sourceDoc);
    const langs = ['en', 'hi', 'gu'];

    const created = {};
    const skipped = {};

    for (const targetLang of langs) {
      const existing = await News.findOne(buildExistingQuery(translationKey, targetLang));
      if (existing) {
        skipped[targetLang] = String(existing._id);
        continue;
      }

      // Translate fields best-effort.
      const titleRes = await translateField(sourceDoc.title, sourceLang, targetLang);
      const descRes = await translateField(sourceDoc.description, sourceLang, targetLang);

      let contentOut = sourceDoc.content;
      if (typeof sourceDoc.content === 'string' && sourceDoc.content.trim() && isPlainTextBody(sourceDoc.content)) {
        const bodyRes = await translateField(sourceDoc.content, sourceLang, targetLang);
        if (bodyRes.ok && typeof bodyRes.text === 'string') contentOut = bodyRes.text;
      }

      const status = String(sourceDoc.status || 'draft').toLowerCase();
      const now = new Date();

      const coverImageUrl = absolutizeUploadsUrl(sourceDoc.coverImageUrl || sourceDoc.imageURL);

      const payload = {
        title: titleRes.ok ? titleRes.text : sourceDoc.title,
        description: descRes.ok ? descRes.text : sourceDoc.description,
        content: contentOut,
        slug: sourceDoc.slug,
        tags: Array.isArray(sourceDoc.tags) ? sourceDoc.tags : [],
        category: sourceDoc.category,
        topic: sourceDoc.topic,
        location: sourceDoc.location,
        lang: targetLang,
        language: targetLang,
        translationKey,
        translationGroupId: translationKey,
        sourceArticleId: sourceDoc._id,
        imageURL: sourceDoc.imageURL,
        coverImageUrl,
        status,
        publishedAt: sourceDoc.publishedAt || (status === 'published' ? now : null),
        date: sourceDoc.date || sourceDoc.publishedAt || now,
      };

      const doc = await News.create(payload);
      created[targetLang] = String(doc && doc._id ? doc._id : '');
    }

    return res.status(200).json({
      ok: true,
      success: true,
      translationKey,
      created,
      skipped,
    });
  } catch (e) {
    console.error('[adminNews.generate-translations] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to generate translations' });
  }
});

module.exports = router;
