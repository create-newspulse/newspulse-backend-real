const SPOTLIGHT_PRIORITY_VALUES = Object.freeze(['normal', 'important', 'top']);
const SPOTLIGHT_PRIORITY_RANK = Object.freeze({ normal: 0, important: 1, top: 2 });

function normalizeSpotlightPriority(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SPOTLIGHT_PRIORITY_VALUES.includes(normalized) ? normalized : 'normal';
}

function getSpotlightPriorityRank(value) {
  return SPOTLIGHT_PRIORITY_RANK[normalizeSpotlightPriority(value)];
}

module.exports = {
  SPOTLIGHT_PRIORITY_VALUES,
  normalizeSpotlightPriority,
  getSpotlightPriorityRank,
};