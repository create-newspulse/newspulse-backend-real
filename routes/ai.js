// KiranOS Lite demo AI route - no external dependencies

const express = require('express');
const router = express.Router();

const SUPPORTED_LANGUAGES = ['en', 'hi', 'gu'];

function normalizeLanguage(input) {
  const lang = (input || '').toLowerCase();
  if (SUPPORTED_LANGUAGES.includes(lang)) return lang;
  return 'en';
}

function buildDemoAnswer(question, articleText, language) {
  const q = (question || '').trim();
  const text = (articleText || '').trim();

  const preview = text.length > 0 ? text.slice(0, 300) : '';
  const hasArticle = preview.length > 0;

  let answer;

  if (language === 'gu') {
    answer =
      'આ એક ડેમો જવાબ છે. હું આ સ્ટોરીને સરળ ભાષામાં સમજાવું છું અને મહત્વના મુદ્દા બતાવું છું. ' +
      (hasArticle
        ? 'આ સ્ટોરીમાં મુખ્ય વાતો આ પ્રમાણે છે: ' + preview
        : 'હાલ માટે ફુલ લેખ ન મળ્યો, પણ તમારો પ્રશ્ન સમજીને સમજાવું છું.');
  } else if (language === 'hi') {
    answer =
      'यह एक डेमो उत्तर है। मैं इस खबर को आसान भाषा में समझा रहा हूँ और मुख्य बिंदुओं को बता रहा हूँ। ' +
      (hasArticle
        ? 'इस खबर के मुख्य पॉइंट्स कुछ इस तरह हैं: ' + preview
        : 'अभी पूरा लेख नहीं मिला, लेकिन आपके सवाल के आधार पर समझा रहा हूँ।');
  } else {
    // en
    answer =
      "This is a demo answer. I'm explaining this story in simple language and highlighting the key points. " +
      (hasArticle
        ? 'Here is a short extract from the story: ' + preview
        : "I don't have the full article text right now, but I can still explain the topic in simple terms.");
  }

  const bullets = [];

  if (q) bullets.push(`User asked: ${q}`);
  if (hasArticle) bullets.push('Summary is based on the article text you shared.');
  bullets.push('This is a safe demo response — real AI answers will come later.');

  return { answer, bullets, language };
}

router.post('/ask', async (req, res) => {
  const body = req.body || {};
  const question = (body.question || '').toString();
  const articleText = (body.articleText || '').toString();
  const language = normalizeLanguage(body.language);

  console.log('[AI] /api/ai/ask hit {');
  console.log('  time:', new Date().toISOString() + ',');
  console.log('  hasQuestion:', !!question, ',');
  console.log('  hasArticleText:', !!articleText, ',');
  console.log("  language:", `'${language}'`);
  console.log('}');

  try {
    if (!question && !articleText) {
      return res.status(200).json({
        ok: false,
        error: 'Missing question or article text',
      });
    }

    const result = buildDemoAnswer(question, articleText, language);

    return res.status(200).json({
      ok: true,
      data: result,
    });
  } catch (err) {
    console.error('[AI][ask-demo] unexpected error', err && err.message ? err.message : err);
    // Even on error, return a graceful response (no HTTP 500)
    return res.status(200).json({
      ok: false,
      error: 'AI service temporarily unavailable, please try again later.',
    });
  }
});

module.exports = router;
