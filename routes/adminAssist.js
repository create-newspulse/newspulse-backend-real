// Admin API: AI Assist suggestions
const express = require('express');
const router = express.Router();

// POST /admin-api/assist/suggest - v1 editorial suggestions
router.post('/suggest', async (req, res) => {
  try {
    const { title = '', content = '', language = 'en' } = req.body;
    
    // Stub response matching frontend AssistSuggestResponse interface
    const stub = {
      title: title || 'Suggested Title',
      slug: (title || 'suggested-title')
        .toLowerCase()
        .replace(/[^\u0000-\u007F]+/g, '') // remove non-ASCII
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 60),
      summary: (content || title || 'Article summary').slice(0, 160) + (content.length > 160 ? '…' : ''),
      tips: ['Add attribution source', 'Verify PTI compliance'],
      language,
    };
    
    return res.json(stub);
  } catch (e) {
    console.error('[assist/suggest] error:', e?.message || e);
    return res.status(500).json({ error: 'assist-suggest-failed' });
  }
});

// POST /admin-api/assist/suggest/v2 - v2 enhanced suggestions
router.post('/suggest/v2', async (req, res) => {
  try {
    const { title = '', content = '', language = 'en' } = req.body;
    
    const baseTitle = title || 'Story Title';
    const latinSlug = baseTitle
      .toLowerCase()
      .replace(/[^\u0000-\u007F]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 60);
    
    const nativeSlug = baseTitle
      .toLowerCase()
      .replace(/\s+/g, '-')
      .slice(0, 60);
    
    const baseContent = content || baseTitle;
    const neutralSummary = baseContent.slice(0, 160) + (baseContent.length > 160 ? '…' : '');
    
    // Stub matching frontend AssistSuggestV2Response interface
    const stub = {
      title: {
        standard: baseTitle,
      },
      slug: {
        latin: latinSlug,
        native: nativeSlug,
      },
      summary: {
        neutral: neutralSummary,
        impact: 'Breaking: ' + baseTitle,
        analytical: 'Analysis: ' + baseTitle,
      },
      seo: {
        keywords: ['news', 'breaking', 'update'],
        hashtags: ['#news', '#breaking'],
        titleHookScore: 75,
        summaryLen: neutralSummary.length,
        notes: ['Good length', 'Add keywords for better SEO'],
      },
      compliance: {
        ptiFlags: [],
        riskWords: [],
        advice: 'PTI compliant – no issues detected',
      },
      duplicate: {
        score: 0.0,
        closestId: null,
      },
      language,
    };
    
    return res.json(stub);
  } catch (e) {
    console.error('[assist/suggest/v2] error:', e?.message || e);
    return res.status(500).json({ error: 'assist-suggest-v2-failed' });
  }
});

module.exports = router;
