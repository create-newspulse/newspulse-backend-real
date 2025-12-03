const express = require('express');
const router = express.Router();
const { askKiranOS } = require('../services/aiClient');
const News = require('../models/News');
const KiranOSLog = require('../models/KiranOSLog');

// POST /api/ai/ask
router.post('/ask', async (req, res) => {
  try {
    console.log('[AI] /api/ai/ask hit', {
      time: new Date().toISOString(),
      hasQuestion: !!(req.body && req.body.question),
      hasArticleText: !!(req.body && req.body.articleText),
      language: (req.body && req.body.language) || null,
    });
    const body = req.body || {};
    const question = String(body.question || '').trim();
    let language = String(body.language || 'en').toLowerCase();
    const articleId = body.articleId ? String(body.articleId) : '';
    let articleText = String(body.articleText || '').trim();

    if (question.length < 3) {
      return res.status(400).json({ ok: false, error: 'Question is too short' });
    }
    if (!['en', 'hi', 'gu'].includes(language)) language = 'en';

    // Log analytics (non-blocking)
    try { await KiranOSLog.create({ question, language, articleId: articleId || undefined, source: 'mobile' }); } catch (logErr) { console.warn('[AI][ask][log-failed]', logErr?.message || logErr); }

    // Optional article lookup if ID provided and text missing
    if (articleId && !articleText) {
      try {
        const doc = await News.findById(articleId).lean();
        if (doc) {
          const parts = [doc.title, doc.description, doc.content, (doc.body || '')].filter(Boolean);
          const joined = parts.join('\n\n');
          articleText = joined.length > 1500 ? joined.slice(0, 1500) : joined;
        }
      } catch (_) {}
    }

    const aiResult = await askKiranOS({ question, language, articleText });
    return res.json({ ok: true, data: aiResult });
  } catch (e) {
    console.error('[AI][ask] error', e?.message || e);
    return res.status(500).json({ ok: false, error: 'KiranOS is currently unavailable. Please try again.' });
  }
});

// POST /api/ai/summarize-article
router.post('/summarize-article', async (req, res) => {
  try {
    const { title = '', content = '', description = '' } = req.body || {};
    const sourceText = String(content || description || '').trim();
    if (!sourceText) {
      return res.status(400).json({ ok: false, message: 'No article content provided for summary.' });
    }
    const maxLen = 280;
    let snippet = sourceText.slice(0, maxLen);
    const lastSpace = snippet.lastIndexOf(' ');
    if (lastSpace > 50) snippet = snippet.slice(0, lastSpace);
    if (snippet.length < sourceText.length) snippet += '...';

    const bullets = [
      'Key point 1: This is a brief automated summary of the article.',
      'Key point 2: In the full KiranOS version, AI will extract factual highlights.',
      'Key point 3: Always cross-check with the full article for complete context.',
    ];

    return res.json({ ok: true, title: title || null, summary: snippet, bullets, meta: { mode: 'demo' } });
  } catch (e) {
    console.error('[AI][summarize-article] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Could not summarize this article.' });
  }
});

module.exports = router;
