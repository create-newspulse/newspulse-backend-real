// KiranOS Lite demo AI route - no external dependencies
const express = require('express');
const router = express.Router();

function sanitizeLanguage(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return ['en', 'hi', 'gu'].includes(l) ? l : 'en';
}

function buildAnswer(question, articleText, language) {
  const q = String(question || '').trim();
  const txt = String(articleText || '').trim();
  const excerptMax = 400;
  let excerpt = txt.slice(0, excerptMax);
  const lastSpace = excerpt.lastIndexOf(' ');
  if (lastSpace > 200) excerpt = excerpt.slice(0, lastSpace);
  if (excerpt.length && txt.length > excerpt.length) excerpt += '...';

  const answer = q
    ? `Here’s a simple explanation based on your question: "${q}"${excerpt ? `\n\nContext excerpt: ${excerpt}` : ''}`
    : `Here’s a concise summary from the provided text.${excerpt ? `\n\nContext excerpt: ${excerpt}` : ''}`;

  const bullets = [
    'Summarizes key points in simple language',
    'Highlights context from the provided text',
    'Deterministic demo response (no external AI)'
  ];

  return { answer, bullets, language };
}

router.post('/ask', async (req, res) => {
  try {
    const body = req.body || {};
    const question = String(body.question || '').trim();
    const articleText = String(body.articleText || '').trim();
    const language = sanitizeLanguage(body.language || 'en');

    if (!question && !articleText) {
      return res.status(200).json({ ok: false, error: 'Missing question or article text' });
    }

    const data = buildAnswer(question, articleText, language);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error('[AI][ask][error]', e);
    return res.status(200).json({ ok: false, error: 'AI service temporarily unavailable' });
  }
});

module.exports = router;
