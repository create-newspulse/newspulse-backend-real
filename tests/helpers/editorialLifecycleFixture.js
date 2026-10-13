require('./publicNewsIsolation');

const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
const { accountAuthFixture } = require('./accountAuthFixture');
const { runPipeline } = require('./pulseDialogueAggregate');
const app = require('../../server');

const models = {
  News: require('../../models/News'),
  Article: require('../../models/Article'),
  EditorialTopic: require('../../models/EditorialTopic'),
  TranslationJob: require('../../models/TranslationJob'),
  AuditLog: require('../../models/AuditLog'),
  PushHistory: require('../../models/PushHistory'),
  WorkflowEvent: require('../../models/WorkflowEvent'),
  PublicConfigVersion: require('../../models/PublicConfigVersion'),
};
const protectedModels = Object.fromEntries(
  ['Media', 'TranslationCache', 'TranslationMemory', 'ArticleAnalyticsEvent', 'ArticleAnalyticsDaily']
    .map(name => [name, require(`../../models/${name}`)])
);
const get = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);
function clone(value) {
  if (value instanceof Date) return new Date(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => typeof item !== 'function').map(([key, item]) => [key, clone(item)]));
  return value;
}
function put(doc, path, value) {
  const fields = path.split('.');
  const last = fields.pop();
  let target = doc;
  for (const field of fields) target = target[field] ||= {};
  target[last] = clone(value);
}
const comparable = value => value instanceof Date ? value.getTime() : value?.toHexString ? value.toHexString() : value;
const equal = (left, right) => comparable(left) === comparable(right) || (left == null && right == null);
const any = (actual, predicate) => Array.isArray(actual) ? actual.some(predicate) : predicate(actual);

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every(part => matches(doc, part));
    if (key === '$or') return value.some(part => matches(doc, part));
    if (key === '$nor') return !value.some(part => matches(doc, part));
    if (key === '$expr') return runPipeline([doc], [{ $match: { $expr: value } }]).length > 0;
    const actual = get(doc, key);
    if (value instanceof RegExp) return any(actual, item => value.test(String(item || '')));
    if (!value || typeof value !== 'object' || value instanceof Date || value.toHexString) {
      return any(actual, item => equal(item, value));
    }
    return Object.entries(value).every(([operator, expected]) => {
      const included = values => any(actual, item => values.some(candidate => candidate instanceof RegExp
        ? candidate.test(String(item || '')) : equal(item, candidate)));
      if (operator === '$in') return included(expected);
      if (operator === '$nin') return !included(expected);
      if (operator === '$ne') return !any(actual, item => equal(item, expected));
      if (operator === '$eq') return any(actual, item => equal(item, expected));
      if (operator === '$exists') return (actual !== undefined) === expected;
      if (operator === '$not') return !matches(doc, { [key]: expected });
      if (operator === '$regex') return any(actual, item => expected.test(String(item || '')));
      const left = comparable(actual);
      const right = comparable(expected);
      if (operator === '$lte') return actual != null && left <= right;
      if (operator === '$lt') return actual != null && left < right;
      if (operator === '$gte') return actual != null && left >= right;
      if (operator === '$gt') return actual != null && left > right;
      throw new Error(`Unsupported editorial fixture operator ${operator}`);
    });
  });
}

function aggregate(rows, pipeline) {
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter(doc => matches(doc, stage.$match));
    else if (stage.$facet) rows = [Object.fromEntries(Object.entries(stage.$facet)
      .map(([key, stages]) => [key, aggregate(rows, stages)]))];
    else if (stage.$group) {
      const minima = Object.entries(stage.$group).filter(([, value]) => value && typeof value === 'object' && '$min' in value);
      const grouped = runPipeline(rows, [{ $group: Object.fromEntries(Object.entries(stage.$group)
        .filter(([key]) => !minima.some(([field]) => field === key))) }]);
      for (const group of grouped) for (const [field, expression] of minima) {
        const values = rows.filter(doc => equal(get(doc, stage.$group._id.slice(1)), group._id))
          .map(doc => get(doc, expression.$min.slice(1))).filter(value => value != null);
        group[field] = values.sort((a, b) => comparable(a) - comparable(b))[0] ?? null;
      }
      rows = grouped;
    } else rows = runPipeline(rows, [stage]);
  }
  return rows;
}

function installEditorialFixture(context) {
  const auth = accountAuthFixture();
  auth.install(context);
  const state = {
    rows: Object.fromEntries(Object.keys(models).map(key => [key, []])),
    calls: [], failures: {}, invalidations: [], transactions: [],
  };
  let sequence = 1000;
  const fail = (name, method) => {
    const key = `${name}.${method}`;
    if (!state.failures[key]) return;
    const error = state.failures[key];
    if (error.once) delete state.failures[key];
    throw Object.assign(new Error('Synthetic storage failure'), { name: 'MongoNetworkError' }, error);
  };
  const apply = (doc, update, inserted) => {
    if (inserted) for (const [key, value] of Object.entries(update.$setOnInsert || {})) put(doc, key, value);
    for (const [key, value] of Object.entries(update.$set || {})) if (value !== undefined) put(doc, key, value);
    for (const key of Object.keys(update.$unset || {})) {
      const parts = key.split('.');
      const last = parts.pop();
      const target = parts.length ? get(doc, parts.join('.')) : doc;
      if (target) delete target[last];
    }
    for (const [key, value] of Object.entries(update.$inc || {})) put(doc, key, (get(doc, key) || 0) + value);
    for (const [key, value] of Object.entries(update.$push || {})) put(doc, key, [...(get(doc, key) || []), value]);
    doc.updatedAt = new Date();
    return doc;
  };
  const hydrate = (name, row) => {
    if (!row || typeof row !== 'object') return row;
    const doc = clone(row);
    const serialize = () => name === 'News'
      ? { ...clone(doc), body: doc.content, id: String(doc._id) }
      : clone(doc);
    Object.defineProperties(doc, {
      toObject: { value: serialize },
      toJSON: { value: serialize },
      set: { value: (patch) => { for (const [key, value] of Object.entries(patch)) put(doc, key, value); } },
      save: { value: async (options) => {
        state.calls.push({ name, method: 'save', options });
        fail(name, 'save');
        const index = state.rows[name].findIndex(item => equal(item._id, doc._id));
        if (index < 0) throw Object.assign(new Error('Synthetic missing document'), { name: 'DocumentNotFoundError' });
        state.rows[name][index] = clone(doc);
        return doc;
      } },
    });
    return doc;
  };
  const query = (name, resolve) => {
    let selection;
    let sort;
    let skip = 0;
    let limit;
    let lean = false;
    const execute = async () => {
      let value = await resolve();
      if (Array.isArray(value)) {
        value = [...value];
        if (sort) value.sort((a, b) => {
          for (const [field, direction] of Object.entries(sort)) {
            const left = comparable(get(a, field));
            const right = comparable(get(b, field));
            if (left < right) return -direction;
            if (left > right) return direction;
          }
          return 0;
        });
        value = value.slice(skip, limit === undefined ? undefined : skip + limit);
      }
      const map = row => {
        if (!row || typeof row !== 'object') return row;
        let out = clone(row);
        if (selection && !selection.includes('-')) {
          out = { _id: row._id };
          for (const field of selection.split(/\s+/).filter(Boolean)) {
            if (get(row, field) !== undefined) put(out, field, get(row, field));
          }
        }
        return lean ? out : hydrate(name, out);
      };
      return Array.isArray(value) ? value.map(map) : map(value);
    };
    return {
      select(value) { selection = value; return this; },
      sort(value) { sort = value; state.calls.push({ name, method: 'sort', value }); return this; },
      skip(value) { skip = value; return this; },
      limit(value) { limit = value; return this; },
      collation() { return this; }, session() { return this; }, maxTimeMS() { return this; },
      lean() { lean = true; return execute(); },
      then(resolveValue, reject) { return execute().then(resolveValue, reject); },
      catch(reject) { return execute().catch(reject); },
    };
  };
  for (const [name, Model] of Object.entries(models)) {
    const invoke = (method, filter, options) => {
      fail(name, method);
      state.calls.push({ name, method, filter: clone(filter), options });
    };
    context.mock.method(Model, 'find', (filter = {}, _projection, options) => query(name, () => {
      invoke('find', filter, options);
      return state.rows[name].filter(doc => matches(doc, filter));
    }));
    context.mock.method(Model, 'findOne', (filter = {}, _projection, options) => query(name, () => {
      invoke('findOne', filter, options);
      return state.rows[name].find(doc => matches(doc, filter)) || null;
    }));
    context.mock.method(Model, 'findById', (id, _projection, options) => query(name, () => {
      invoke('findById', { _id: id }, options);
      return state.rows[name].find(doc => equal(doc._id, id)) || null;
    }));
    context.mock.method(Model, 'countDocuments', (filter = {}) => query(name, () => {
      invoke('countDocuments', filter);
      return state.rows[name].filter(doc => matches(doc, filter)).length;
    }));
    const updateOne = (method, filter, update, options = {}) => query(name, () => {
      invoke(method, filter, options);
      let row = state.rows[name].find(doc => matches(doc, filter));
      const inserted = !row && options.upsert;
      if (!row && !inserted) return null;
      if (!row) {
        row = { _id: (++sequence).toString(16).padStart(24, '0') };
        for (const [key, value] of Object.entries(filter)) {
          if (!key.startsWith('$') && (value == null || typeof value !== 'object' || value instanceof Date || value.toHexString)) {
            put(row, key, value);
          }
        }
      }
      const next = apply(clone(row), update, inserted);
      if (name === 'Article' && state.rows[name].some(doc => doc.slug === next.slug && !equal(doc._id, row._id))) {
        throw Object.assign(new Error('Synthetic duplicate slug'), { code: 11000 });
      }
      if (inserted) state.rows[name].push(next);
      else state.rows[name][state.rows[name].indexOf(row)] = next;
      return next;
    });
    context.mock.method(Model, 'findOneAndUpdate', (filter, update, options) => updateOne('findOneAndUpdate', filter, update, options));
    context.mock.method(Model, 'findByIdAndUpdate', (id, update, options) => updateOne('findByIdAndUpdate', { _id: id }, update, options));
    context.mock.method(Model, 'updateMany', async (filter, update, options) => {
      invoke('updateMany', filter, options);
      const rows = state.rows[name].filter(doc => matches(doc, filter));
      for (const row of rows) apply(row, update);
      return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length };
    });
    context.mock.method(Model, 'updateOne', async (filter, update, options) => {
      invoke('updateOne', filter, options);
      const row = state.rows[name].find(doc => matches(doc, filter));
      if (row) apply(row, update);
      return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    });
    context.mock.method(Model, 'deleteMany', async (filter, options) => {
      invoke('deleteMany', filter, options);
      const deletedCount = state.rows[name].filter(doc => matches(doc, filter)).length;
      state.rows[name] = state.rows[name].filter(doc => !matches(doc, filter));
      return { acknowledged: true, deletedCount };
    });
    context.mock.method(Model, 'create', async (input, options) => {
      invoke('create', {}, options);
      const create = value => {
        const row = { _id: (++sequence).toString(16).padStart(24, '0'), ...clone(value) };
        state.rows[name].push(row);
        return hydrate(name, row);
      };
      return Array.isArray(input) ? input.map(create) : create(input);
    });
    context.mock.method(Model, 'aggregate', pipeline => ({
      option(options) { state.calls.push({ name, method: 'aggregate', pipeline, options }); return this; },
      exec: async () => { fail(name, 'aggregate'); return aggregate(clone(state.rows[name]), pipeline); },
    }));
  }
  context.mock.method(mongoose, 'startSession', async () => {
    const session = {
      async withTransaction(work) {
        const before = clone(state.rows);
        try { await work(); this.committed = true; }
        catch (error) { state.rows = before; this.aborted = true; throw error; }
      },
      async endSession() { this.ended = true; },
    };
    state.transactions.push(session);
    return session;
  });
  const previousUrl = process.env.PUBLIC_CONTENT_REVALIDATE_URL;
  process.env.PUBLIC_CONTENT_REVALIDATE_URL = 'http://127.0.0.1/editorial-test-revalidate';
  context.after(() => {
    if (previousUrl === undefined) delete process.env.PUBLIC_CONTENT_REVALIDATE_URL;
    else process.env.PUBLIC_CONTENT_REVALIDATE_URL = previousUrl;
  });
  context.mock.method(global, 'fetch', async (_url, options) => {
    state.invalidations.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => '' };
  });
  for (const [name, Model] of Object.entries(protectedModels)) {
    context.mock.method(Model, 'deleteMany', () => assert.fail(`${name} must not be deleted by editorial lifecycle`));
    context.mock.method(Model, 'deleteOne', () => assert.fail(`${name} must not be deleted by editorial lifecycle`));
  }
  state.request = (method, path, body, role = 'founder', application = app) => {
    let call = request(application)[method](path);
    if (role) call = call.set('Authorization', `Bearer ${auth.token(role)}`);
    return body === undefined ? call : call.send(body);
  };
  state.newsDoc = id => hydrate('News', state.rows.News.find(doc => equal(doc._id, id)));
  return state;
}

function seedGroup(state, { status = 'published', copies = true, sharedSlug = false } = {}) {
  const publication = new Date('2026-09-01T08:00:00.000Z');
  const ids = ['507f1f77bcf86cd79943a001', '507f1f77bcf86cd79943a002', '507f1f77bcf86cd79943a003'];
  const slugs = { en: 'story-en', hi: 'story-hi', gu: 'story-gu' };
  for (const [index, language] of ['en', 'hi', 'gu'].entries()) {
    const doc = {
      _id: ids[index], title: `${language} headline`, description: `${language} summary`, content: `<p>${language} body</p>`,
      category: 'faith-culture', tags: ['navratri-2026'], slug: sharedSlug ? 'shared-story' : slugs[language],
      slugs: sharedSlug ? { en: 'shared-story', hi: 'shared-story', gu: 'shared-story' } : { ...slugs },
      lang: language, language, originalLang: language, sourceLanguage: 'en',
      sourceArticleId: ids[0], translationGroupId: 'story-test-group', translationKey: 'story-test-group',
      status, publishedAt: status === 'draft' ? null : publication, deletedAt: null,
      workflowStage: status === 'published' ? 'PUBLISHED' : 'DRAFT', workflowHistory: [],
      createdAt: new Date('2026-08-01T00:00:00.000Z'), updatedAt: publication,
      coverImage: { url: '/uploads/shared.jpg', alt: 'Shared cover' }, coverImageUrl: '/uploads/shared.jpg',
      translations: {}, translationStatus: {}, syncVersion: 1,
    };
    state.rows.News.push(doc);
    if (copies && (!sharedSlug || index === 0)) state.rows.Article.push({
      ...clone(doc), _id: ids[index].replace(/^5/, '6'), summary: doc.description, sourceNewsId: doc._id,
    });
  }
  state.rows.EditorialTopic.push({
    _id: '707f1f77bcf86cd79943a001', slug: 'navratri-2026',
    name: { en: 'Navratri', hi: 'Navratri', gu: 'Navratri' }, description: {},
    articleTags: ['navratri-2026'], pinnedArticleId: ids[0], active: true,
    startsAt: new Date('2020-01-01T00:00:00.000Z'), expiresAt: null, order: 1,
  });
  return { ids, publication };
}

module.exports = { installEditorialFixture, seedGroup, matches, models };
