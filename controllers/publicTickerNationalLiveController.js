const BroadcastItem = require('../models/BroadcastItem');
const Article = require('../models/Article');

const { formatIstTimeText } = require('../src/utils/istDate');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function clampInt(v, { fallback, min, max }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.floor(n);
  return Math.min(max, Math.max(min, rounded));
}

function toOneLine(v) {
  const s = typeof v === 'string' ? v : '';
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function buildNotExpiredFilter() {
  const now = new Date();
  return {
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gte: now } }],
  };
}

function resolveBroadcastText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = normalizeLang(lang) || 'en';

  const src = SUPPORTED_LANGS.has(String(d.sourceLang || ''))
    ? String(d.sourceLang)
    : (SUPPORTED_LANGS.has(String(d.language || '')) ? String(d.language) : null);

  const translations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (translations && typeof translations[target] === 'string' && translations[target].trim() ? translations[target] : null) ||
    (i18n && typeof i18n[target] === 'string' && i18n[target].trim() ? i18n[target] : null) ||
    (legacy && typeof legacy[target] === 'string' && legacy[target].trim() ? legacy[target] : null) ||
    (src && translations && typeof translations[src] === 'string' && translations[src].trim() ? translations[src] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');

  return toOneLine(String(pick || ''));
}

function mapLiveBroadcastItem(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const createdAt = d.createdAt instanceof Date ? d.createdAt : (d.createdAt ? new Date(d.createdAt) : null);
  return {
    kind: 'live',
    text: resolveBroadcastText(d, lang),
    timeText: formatIstTimeText(createdAt || new Date()) || '',
    href: typeof d.linkUrl === 'string' && d.linkUrl.trim() ? String(d.linkUrl).trim() : null,
  };
}

function mapNationalArticle(article, lang) {
  const a = article && typeof article === 'object' ? article : {};
  const dt = a.publishedAt || a.createdAt || new Date();
  const slugs = a.slugs && typeof a.slugs === 'object' ? a.slugs : null;
  const slug = (slugs && typeof slugs[lang] === 'string' && slugs[lang].trim() ? slugs[lang] : null) || a.slug;
  return {
    kind: 'story',
    text: toOneLine(a.title || ''),
    timeText: formatIstTimeText(dt) || '',
    href: typeof slug === 'string' && slug.trim() ? `/news/${slug.trim()}` : null,
  };
}

async function getNationalLiveTicker(req, res) {
  try {
    const langRaw = Object.prototype.hasOwnProperty.call(req.query || {}, 'lang') ? req.query.lang : undefined;
    const lang = langRaw === undefined ? 'en' : normalizeLang(langRaw);
    if (!lang) {
      return res.status(400).json({ ok: false, code: 'INVALID_LANG', message: 'Invalid lang. Expected en|hi|gu' });
    }

    const limit = clampInt(req.query && req.query.limit, { fallback: 5, min: 1, max: 50 });
    const hours = clampInt(req.query && req.query.hours, { fallback: 24, min: 1, max: 168 });
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    const notExpired = buildNotExpiredFilter();
    const baseAnd = [
      { type: 'live', isLive: true },
      notExpired,
      { $or: [{ isActive: true }, { isActive: { $exists: false } }] },
      { createdAt: { $gte: cutoff } },
    ];

    // If deployments have scoping fields, prefer them; otherwise fall back to unscoped items.
    const scopedFilter = {
      $and: [...baseAnd, { $or: [{ scope: 'national' }, { category: 'national' }] }],
    };

    let liveDocs = await BroadcastItem.find(scopedFilter)
      .sort({ isPinned: -1, priority: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    if (!liveDocs || liveDocs.length === 0) {
      liveDocs = await BroadcastItem.find({ $and: baseAnd })
        .sort({ isPinned: -1, priority: -1, createdAt: -1 })
        .limit(limit)
        .lean();
    }

    const liveItems = (liveDocs || []).map((d) => mapLiveBroadcastItem(d, lang));

    const remaining = Math.max(0, limit - liveItems.length);
    if (remaining <= 0) {
      return res.status(200).json(liveItems.slice(0, limit));
    }

    const articleFilter = {
      status: 'published',
      category: 'national',
      language: lang,
      $or: [{ publishedAt: { $gte: cutoff } }, { publishedAt: null, createdAt: { $gte: cutoff } }],
    };

    const articleDocs = await Article.find(articleFilter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(remaining)
      .lean();

    const storyItems = (articleDocs || []).map((a) => mapNationalArticle(a, lang));
    const out = [...liveItems, ...storyItems].slice(0, limit);

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Failed to load national live ticker' });
  }
}

module.exports = {
  getNationalLiveTicker,
};
