const test = require('node:test');
const assert = require('node:assert/strict');

const Article = require('../models/Article');
const { getSpotlightPriorityRank, normalizeSpotlightPriority } = require('../services/spotlightPriority.service');

function makeArticle(overrides = {}) {
  return new Article({
    title: 'Spotlight priority story',
    slug: `spotlight-priority-${Math.random().toString(16).slice(2)}`,
    category: 'national',
    language: 'en',
    status: 'published',
    ...overrides,
  });
}

test('Article spotlightPriority defaults missing values to normal', () => {
  const article = makeArticle();

  assert.equal(article.spotlightPriority, 'normal');
  assert.equal(normalizeSpotlightPriority(undefined), 'normal');
  assert.equal(getSpotlightPriorityRank(undefined), getSpotlightPriorityRank('normal'));
});

test('Article spotlightPriority accepts normal important and top', () => {
  assert.equal(makeArticle({ spotlightPriority: 'normal' }).spotlightPriority, 'normal');
  assert.equal(makeArticle({ spotlightPriority: 'important' }).spotlightPriority, 'important');
  assert.equal(makeArticle({ spotlightPriority: 'top' }).spotlightPriority, 'top');
});

test('Article spotlightPriority normalizes invalid values to normal', () => {
  const article = makeArticle({ spotlightPriority: 'urgent' });

  assert.equal(article.spotlightPriority, 'normal');
});