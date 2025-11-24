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
 * @param {PriorityInput} input
 * @returns {CommunityPriority}
 */
function computeCommunityPriority(input) {
  const {
    category = '',
    riskScore = 0,
    flags = [],
    body = '',
    location = '',
  } = input || {};

  const wc = wordCount(body);
  const cat = category.toLowerCase();

  const hasFlag = (f) => Array.isArray(flags) && flags.includes(f);

  const founderCats = new Set([
    'civic_issue',
    'crime',
    'corruption',
    'government',
    'investigation',
  ]);
  const editorCats = new Set([
    'regional',
    'youth',
    'campus',
    'business',
    'health',
    'environment',
  ]);

  // FOUNDER_REVIEW
  if (
    riskScore >= 80 ||
    hasFlag('mentions_minor') ||
    hasFlag('needs_legal_review') ||
    hasFlag('possible_defamation') ||
    hasFlag('hate_speech') ||
    hasFlag('election_sensitive') ||
    founderCats.has(cat)
  ) {
    return 'FOUNDER_REVIEW';
  }

  // EDITOR_REVIEW
  if (
    (riskScore >= 40 && riskScore <= 79) ||
    hasFlag('needs_verification') ||
    hasFlag('sensitive_politics') ||
    hasFlag('strong_opinion') ||
    hasFlag('unclear_source') ||
    editorCats.has(cat)
  ) {
    return 'EDITOR_REVIEW';
  }

  // LOW_PRIORITY (fallback for safe / low-impact content)
  return 'LOW_PRIORITY';
}

module.exports = {
  computeCommunityPriority,
};
