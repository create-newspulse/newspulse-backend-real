// services/communityPriority.js
// Priority computation for CommunitySubmission documents.
// Pure JS version of computeCommunityPriority used by community routes and AI pipeline.

/**
 * @typedef {('FOUNDER_REVIEW'|'EDITOR_REVIEW'|'LOW_PRIORITY')} CommunityPriority
 */

/**
 * @typedef PriorityInput
 * @property {string} [category]
 * @property {number} [riskScore]
 * @property {string[]} [flags]
 * @property {string} [body]
 * @property {string} [location]
 */

/**
 * @param {string} [text]
 * @returns {number}
 */
function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * @param {string[]} [flags]
 * @param {string[]} candidates
 * @returns {boolean}
 */
function hasAnyFlag(flags = [], candidates = []) {
  const set = new Set(Array.isArray(flags) ? flags : []);
  return candidates.some((c) => set.has(c));
}

/**
 * @param {string} [text]
 * @param {string[]} keywords
 * @returns {boolean}
 */
function textIncludesAny(text = '', keywords = []) {
  const lower = String(text || '').toLowerCase();
  return keywords.some((kw) => lower.includes(String(kw).toLowerCase()));
}

/**
 * @param {PriorityInput} input
 * @returns {CommunityPriority}
 */
function computeCommunityPriority(input) {
  const {
    category,
    riskScore,
    flags,
    body,
    location, // kept for future use if needed
  } = input || {};

  const cat = (category || '').toLowerCase().trim();
  const wc = wordCount(body);
  const f = Array.isArray(flags) ? flags : [];
  const score = typeof riskScore === 'number' ? riskScore : 0;
  const text = body || '';

  const regionalCats = [
    'regional',
    'civic_issue',
    'civic',
    'government',
    'politics',
    'crime',
    'corruption',
    'investigation',
  ];

  const youthCats = [
    'youth',
    'campus',
    'student',
  ];

  const glamourCats = [
    'glamour',
    'entertainment',
    'bollywood',
    'hollywood',
    'celebrity',
  ];

  const lifestyleCats = [
    'lifestyle',
    'culture',
    'feelgood',
    'events',
    'general_tip',
    'misc',
  ];

  const isRegionalLike = regionalCats.includes(cat);
  const isYouthLike = youthCats.includes(cat);
  const isGlamourLike = glamourCats.includes(cat);
  const isLifestyleLike = lifestyleCats.includes(cat);

  // A) 🔴 Extra safety rules (always Founder)
  if (
    hasAnyFlag(f, [
      'legal_risk',
      'defamation_risk',
      'communal_sensitive',
      'hate_speech',
      'election_sensitive',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  if (
    textIncludesAny(text, [
      'kill myself',
      'end my life',
      'take my life',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  if (score >= 80) {
    return 'FOUNDER_REVIEW';
  }

  // B) 🔴 Regional / Civic / Government serious stories
  if (
    isRegionalLike &&
    textIncludesAny(text, [
      'death',
      'died',
      'dead body',
      'serious injury',
      'severely injured',
      'major accident',
      'collision',
      'fire',
      'blast',
      'explosion',
      'flood',
      'landslide',
      'building collapse',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  if (
    isRegionalLike &&
    textIncludesAny(text, [
      'police case',
      'fir',
      'f.i.r',
      'arrest',
      'accused',
      'crime case',
      'fraud',
      'scam',
      'cheating case',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  if (
    isRegionalLike &&
    textIncludesAny(text, [
      'corruption',
      'bribe',
      'bribery',
      'took money',
      'demanded money',
    ]) &&
    textIncludesAny(text, ['mla', 'mp', 'minister', 'officer', 'official'])
  ) {
    return 'FOUNDER_REVIEW';
  }

  // C) 🔴 Youth safety / campus tension
  if (
    isYouthLike &&
    textIncludesAny(text, [
      'harassment',
      'abuse',
      'ragging',
      'bullying',
      'paper leak',
      'exam leak',
      'drug issue',
      'drugs in campus',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  if (
    isYouthLike &&
    textIncludesAny(text, [
      'campus protest',
      'student protest',
      'clash',
      'riot',
      'communal tension',
    ])
  ) {
    return 'FOUNDER_REVIEW';
  }

  // D) 🔴 Glamour / gossip with sensitive angles
  if (
    isGlamourLike &&
    textIncludesAny(text, [
      'allegation',
      'accused',
      'blamed',
      'serious charges',
    ]) &&
    textIncludesAny(text, ['religion', 'community', 'caste'])
  ) {
    return 'FOUNDER_REVIEW';
  }

  // E) 🟢 Promotional / spammy / weak stories → LOW_PRIORITY
  if (
    hasAnyFlag(f, [
      'spam',
      'promo',
      'marketing',
      'off_topic',
      'very_weak',
    ])
  ) {
    return 'LOW_PRIORITY';
  }

  if (
    textIncludesAny(text, [
      'buy now',
      'discount',
      'offer code',
      'use my link',
      'subscribe to my channel',
      'follow my page',
    ])
  ) {
    return 'LOW_PRIORITY';
  }

  if (wc < 40 && score < 40 && !isRegionalLike && !isYouthLike) {
    return 'LOW_PRIORITY';
  }

  // F) 🟡 Editor review for everything else serious but not critical
  if (
    isRegionalLike &&
    textIncludesAny(text, [
      'government scheme',
      'yojana',
      'policy',
      'benefit not received',
      'protest',
      'strike',
      'public anger',
      'public outrage',
    ])
  ) {
    return 'EDITOR_REVIEW';
  }

  if (
    isYouthLike &&
    textIncludesAny(text, [
      'competition',
      'tournament',
      'festival',
      'college fest',
      'achievement',
      'rank',
      'result',
    ])
  ) {
    return 'EDITOR_REVIEW';
  }

  if (
    isGlamourLike &&
    textIncludesAny(text, [
      'film release',
      'movie release',
      'trailer',
      'song launch',
      'event',
      'award show',
    ])
  ) {
    return 'EDITOR_REVIEW';
  }

  // G) Fallback to riskScore
  if (score >= 70) {
    return 'FOUNDER_REVIEW';
  }

  if (score >= 30) {
    return 'EDITOR_REVIEW';
  }

  return 'LOW_PRIORITY';
}

module.exports = {
  computeCommunityPriority,
};
