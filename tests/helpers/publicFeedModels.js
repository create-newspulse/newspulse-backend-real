const News = require('../../models/News');
const PublicArticle = require('../../models/Article');

function valueAt(doc, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], doc);
}

function equal(value, expected) {
  if (Array.isArray(value)) return value.some((item) => equal(item, expected));
  if (expected instanceof RegExp) return expected.test(String(value || ''));
  if (expected === null) return value == null;
  return String(value) === String(expected);
}

function matchesField(value, condition) {
  if (!condition || typeof condition !== 'object' || condition instanceof RegExp
    || condition instanceof Date || Array.isArray(condition)) return equal(value, condition);
  return Object.entries(condition).every(([operator, expected]) => {
    if (operator === '$in') return expected.some((item) => equal(value, item));
    if (operator === '$nin') return !expected.some((item) => equal(value, item));
    if (operator === '$ne') return !equal(value, expected);
    if (operator === '$exists') return (value !== undefined) === Boolean(expected);
    if (operator === '$lte') return value != null && new Date(value).getTime() <= new Date(expected).getTime();
    return equal(value?.[operator], expected);
  });
}

function matchesFilter(doc, filter = {}) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$and') return condition.every((clause) => matchesFilter(doc, clause));
    if (field === '$or') return condition.some((clause) => matchesFilter(doc, clause));
    return matchesField(valueAt(doc, field), condition);
  });
}

function project(doc, fields) {
  if (!fields) return { ...doc };
  const result = { _id: doc._id };
  for (const path of fields.split(/\s+/).filter(Boolean)) {
    const value = valueAt(doc, path);
    if (value === undefined) continue;
    const parts = path.split('.');
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {});
    target[parts[parts.length - 1]] = value;
  }
  return result;
}

function makeQuery(items, captured = {}, single = false) {
  let rows = [...items];
  let fields = '';
  const result = () => single ? (rows[0] ? project(rows[0], fields) : null) : rows.map((doc) => project(doc, fields));
  return {
    select(value) { fields = value; captured.select = value; return this; },
    maxTimeMS() { return this; },
    sort(value) {
      captured.sort = value;
      rows.sort((left, right) => {
        for (const [field, direction] of Object.entries(value)) {
          const a = valueAt(left, field);
          const b = valueAt(right, field);
          if (a === b) continue;
          if (a == null) return -direction;
          if (b == null) return direction;
          return (a > b ? 1 : -1) * direction;
        }
        return 0;
      });
      return this;
    },
    skip(value) { captured.skip = value; rows = rows.slice(value); return this; },
    limit(value) { captured.limit = value; rows = rows.slice(0, value); return this; },
    lean: async () => result(),
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
}

function installFeedModels(t, { news = [], copies = [] } = {}) {
  const captured = { news: [], copies: [] };
  for (const [model, rows, queries] of [[News, news, captured.news], [PublicArticle, copies, captured.copies]]) {
    t.mock.method(model, 'find', (filter = {}) => {
      const call = { filter };
      queries.push(call);
      return makeQuery(rows.filter((doc) => matchesFilter(doc, filter)), call);
    });
    t.mock.method(model, 'findOne', (filter = {}) => makeQuery(rows.filter((doc) => matchesFilter(doc, filter)), {}, true));
    t.mock.method(model, 'findById', (id) => makeQuery(rows.filter((doc) => String(doc._id) === String(id)), {}, true));
    t.mock.method(model, 'countDocuments', async (filter = {}) => rows.filter((doc) => matchesFilter(doc, filter)).length);
  }
  return captured;
}

function publishedNews(number, overrides = {}) {
  const id = number.toString(16).padStart(24, '0');
  return {
    _id: id, title: `Story ${number}`, description: `Summary ${number}`, content: `Body ${number}`,
    slug: `story-${number}`, category: 'regional', status: 'published',
    lang: 'gu', language: 'gu', originalLang: 'gu',
    publishedAt: new Date('2026-01-01T00:00:00.000Z'), createdAt: new Date('2026-01-01T00:00:00.000Z'),
    translations: {}, translationStatus: {}, ...overrides,
  };
}

function bucket(lang, overrides = {}) {
  return { title: `${lang} title`, summary: `${lang} summary`, content: `${lang} body`, ...overrides };
}

function publishedArticleForNews(doc, overrides = {}) {
  return {
    ...doc,
    _id: `f${String(doc._id).slice(1)}`,
    sourceNewsId: doc._id,
    summary: doc.description,
    ...overrides,
  };
}

module.exports = { matchesFilter, makeQuery, installFeedModels, publishedNews, publishedArticleForNews, bucket };
