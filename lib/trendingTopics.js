const TrendingTopic = require('../models/TrendingTopic');

const DEFAULT_TRENDING_TOPICS = [
  { key: 'trending', label: 'Trending', href: '/trending', colorKey: 'blue' },
  { key: 'breaking', label: 'Breaking', href: '/breaking', colorKey: 'red' },
  { key: 'sports', label: 'Sports', href: '/sports', colorKey: 'green' },
  { key: 'gold-rates', label: 'Gold rates', href: '/gold-rates', colorKey: 'yellow' },
  { key: 'fuel-prices', label: 'Fuel Prices', href: '/fuel-prices', colorKey: 'orange' },
  { key: 'weather', label: 'Weather', href: '/weather', colorKey: 'sky' },
  { key: 'gujarat', label: 'Gujarat', href: '/gujarat', colorKey: 'purple' },
  { key: 'markets', label: 'Markets', href: '/markets', colorKey: 'emerald' },
  { key: 'tech-ai', label: 'Tech & AI', href: '/tech-ai', colorKey: 'indigo' },
  { key: 'education', label: 'Education', href: '/education', colorKey: 'teal' },
];

function normalizeDefaults() {
  return DEFAULT_TRENDING_TOPICS.map((t, idx) => ({
    key: String(t.key || '').trim().toLowerCase(),
    label: String(t.label || '').trim(),
    href: String(t.href || '').trim(),
    colorKey: String(t.colorKey || '').trim(),
    order: idx,
    enabled: true,
  }));
}

async function ensureTrendingTopicsSeeded() {
  const count = await TrendingTopic.countDocuments({});
  if (count > 0) return { ok: true, seeded: false, count };
  const docs = normalizeDefaults();
  await TrendingTopic.insertMany(docs, { ordered: true });
  return { ok: true, seeded: true, count: docs.length };
}

async function resetTrendingTopicsToDefaults() {
  await TrendingTopic.deleteMany({});
  const docs = normalizeDefaults();
  await TrendingTopic.insertMany(docs, { ordered: true });
  return { ok: true, count: docs.length };
}

module.exports = {
  DEFAULT_TRENDING_TOPICS,
  ensureTrendingTopicsSeeded,
  resetTrendingTopicsToDefaults,
};
