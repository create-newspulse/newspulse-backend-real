const TOPIC_KEYWORDS = {
  politics: ['election', 'minister', 'pm', 'cm', 'bjp', 'inc', 'aap', 'congress', 'parliament', 'assembly', 'government'],
  crime: ['murder', 'rape', 'arrest', 'police', 'crime', 'fir', 'kidnap', 'assault', 'shooting'],
  legal: ['court', 'judge', 'law', 'petition', 'bail', 'verdict', 'supreme court', 'high court'],
  communal: ['riot', 'communal', 'religion', 'temple', 'mosque', 'church', 'hindu', 'muslim', 'christian'],
  health: ['covid', 'virus', 'disease', 'vaccine', 'hospital', 'injury', 'dead', 'death'],
};

function classifyTopics(text) {
  const s = String(text || '').toLowerCase();
  const tags = [];
  for (const [tag, words] of Object.entries(TOPIC_KEYWORDS)) {
    if (words.some(w => s.includes(w))) tags.push(tag);
  }
  return tags;
}

function isStrictTopic(tags) {
  const strictSet = new Set(String(process.env.TRANSLATE_STRICT_TOPICS || 'politics,crime,legal,communal,health')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean));

  return Array.isArray(tags) && tags.some(t => strictSet.has(String(t).toLowerCase()));
}

module.exports = { classifyTopics, isStrictTopic };
