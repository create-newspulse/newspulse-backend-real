const { z } = require('zod');
const EditorialTopic = require('../models/EditorialTopic');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { readLogicalArticleGroups } = require('./articleLogicalCounts.service');
const { inArticleTransaction, buildPublicCopyFilter } = require('./articleLifecycle.service');
const { invalidateArticleContent } = require('./publicContentInvalidation.service');
const { normalizeLang, SUPPORTED_LANGS } = require('./mapArticleForLang');
const { QUERY_MS, TopicError, invalid, parseId, parseQuery, pagination, findAdminTopic } = require('./editorialTopics.service');

const COLLATION = { locale: 'simple' };
const MAX_STORY_IDS = 50;
const MAX_DOCUMENTS = 10000;
const MAX_TERMS = 12;
const TEXT_LIMIT = 2000;
const CONTENT_LIMIT = 8000;
const STORY_SELECT = 'title slug slugs category lang language originalLang tags publishedAt createdAt';
const selectionInput = z.object({
  storyIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(MAX_STORY_IDS)
    .transform(ids => [...new Set(ids.map(id => id.toLowerCase()))]),
}).strict();

function conflict(message, code = 'TOPIC_MEMBERSHIP_CONFLICT') {
  return new TopicError(409, code, message);
}

function topicTags(topic) {
  if (!Array.isArray(topic.articleTags) || !topic.articleTags.length
    || !topic.articleTags.every(EditorialTopic.isExactTopicTag)) {
    throw conflict('The topic has invalid association tags. Founder review is required.');
  }
  return topic.articleTags;
}

function articleTags(doc) {
  if (doc.tags == null) return [];
  if (!Array.isArray(doc.tags) || !doc.tags.every(tag => typeof tag === 'string')) {
    throw conflict('The story has invalid tags. Review its metadata before assigning topics.');
  }
  return doc.tags;
}

function isMembershipTag(tag) {
  return tag.startsWith('topic:') && EditorialTopic.isCanonicalTopicSlug(tag.slice(6));
}

async function tagOwners(tags, session) {
  const docs = await EditorialTopic.find({ articleTags: { $in: tags } }, null, { session })
    .select('_id articleTags').collation(COLLATION).limit(MAX_DOCUMENTS + 1).maxTimeMS(QUERY_MS).lean();
  if (docs.length > MAX_DOCUMENTS) throw conflict('Too many overlapping topic definitions. Founder review is required.');
  const owners = new Map();
  for (const doc of docs) for (const tag of topicTags(doc)) {
    if (!owners.has(tag)) owners.set(tag, new Set());
    owners.get(tag).add(String(doc._id));
  }
  return owners;
}

function safeMembershipTags(topic, owners) {
  return topicTags(topic).filter(tag => isMembershipTag(tag)
    && [...(owners.get(tag) || [])].every(id => id === String(topic._id)));
}

function preferredMembershipTag(topic, owners) {
  const safe = safeMembershipTags(topic, owners);
  return safe.find(tag => tag === `topic:${topic.slug}`) || safe[0] || null;
}

function topicOption(topic, lang, now, owners) {
  const promotionState = !topic.active ? 'inactive'
    : new Date(topic.startsAt) > now ? 'upcoming'
      : topic.expiresAt && new Date(topic.expiresAt) <= now ? 'archived' : 'active';
  const membershipTag = preferredMembershipTag(topic, owners);
  return {
    id: String(topic._id), title: topic.name[lang], slug: topic.slug, name: topic.name,
    active: topic.active, promotionState, startsAt: topic.startsAt, expiresAt: topic.expiresAt || null,
    articleTags: topicTags(topic), membershipTag, assignmentSupported: Boolean(membershipTag),
  };
}

function groupSource(members) {
  const ordered = [...members].sort((a, b) => String(a._id).localeCompare(String(b._id)));
  return ordered.find(doc => String(doc.sourceArticleId || '') === String(doc._id))
    || ordered.find(doc => members.some(member => String(member.sourceArticleId || '') === String(doc._id)))
    || ordered[0];
}

function membership(members, topic) {
  const configured = topicTags(topic);
  const matches = members.map(doc => articleTags(doc).some(tag => configured.includes(tag)));
  return { attached: matches.some(Boolean), membershipConsistent: matches.every(value => value === matches[0]) };
}

function storyCard(members, topic, lang) {
  const source = groupSource(members);
  const language = doc => normalizeLang(doc.originalLang) || normalizeLang(doc.language) || normalizeLang(doc.lang);
  const article = members.find(doc => language(doc) === lang) || source;
  const statuses = new Set(members.map(doc => doc.deletedAt ? 'deleted' : (doc.status || 'draft')));
  const publishedAt = source.publishedAt || members.map(doc => doc.publishedAt).filter(Boolean)
    .sort((a, b) => new Date(a) - new Date(b))[0] || null;
  return {
    logicalStoryId: String(source._id), articleId: String(article._id),
    variantIds: members.map(doc => String(doc._id)).sort(),
    translationGroupId: source.translationGroupId || null, translationKey: source.translationKey || null,
    title: article.title, slug: article.slug || null, category: article.category,
    status: statuses.size === 1 ? [...statuses][0] : 'mixed', publishedAt,
    availableLanguages: SUPPORTED_LANGS.filter(value => members.some(doc => language(doc) === value)),
    pinned: members.some(doc => String(doc._id) === String(topic.pinnedArticleId || '')),
    ...membership(members, topic),
  };
}

function readGroups(filter, session) {
  return readLogicalArticleGroups(filter, session, {
    select: STORY_SELECT, maxDocuments: MAX_DOCUMENTS, collation: COLLATION,
  });
}

async function selectedGroups(ids, session) {
  const groups = await readGroups({ _id: { $in: ids.map(parseId) } }, session);
  const found = new Set(groups.flatMap(members => members.map(doc => String(doc._id))));
  if (ids.some(id => !found.has(id))) throw new TopicError(404, 'STORY_NOT_FOUND', 'CMS story not found');
  return groups;
}

function storyQuery(query, kind) {
  const { q, ...rest } = query;
  if (kind === 'attached' && q !== undefined) throw invalid('Unknown query parameter');
  const options = parseQuery({ limit: '20', ...rest }, 'stories');
  if (q !== undefined && (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 120
    || /[\u0000-\u001f\u007f]/.test(q))) throw invalid('q must contain 2-120 characters');
  if (kind === 'search' && q === undefined) throw invalid('q is required');
  return { ...options, q: q?.trim() };
}

function pageGroups(groups, topic, options) {
  const rows = groups.map(members => ({ members, card: storyCard(members, topic, options.lang) }));
  rows.sort((a, b) => new Date(b.card.publishedAt || 0) - new Date(a.card.publishedAt || 0)
    || a.card.logicalStoryId.localeCompare(b.card.logicalStoryId));
  const selected = rows.slice((options.page - 1) * options.limit, options.page * options.limit);
  return {
    selected,
    result: { unit: 'logical-story', lang: options.lang, topicId: String(topic._id),
      items: selected.map(row => row.card), ...pagination(rows.length, options.page, options.limit, selected.length) },
  };
}

async function listAvailableTopics(query, now = new Date()) {
  const { lang = 'gu', storyId, ...rest } = query;
  if (!SUPPORTED_LANGS.includes(lang)) throw invalid('lang must be gu, hi, or en');
  if (storyId !== undefined) parseId(storyId);
  const { active, page, limit } = parseQuery(rest, 'admin');
  const filter = active === 'all' ? {} : { active: active === 'true' };
  return inArticleTransaction(async session => {
    const groups = storyId === undefined ? [] : await selectedGroups([storyId.toLowerCase()], session);
    const docs = await EditorialTopic.find(filter, null, { session }).sort({ order: 1, _id: 1 })
      .skip((page - 1) * limit).limit(limit).maxTimeMS(QUERY_MS).lean();
    const total = await EditorialTopic.countDocuments(filter).session(session).maxTimeMS(QUERY_MS);
    const owners = docs.length ? await tagOwners([...new Set(docs.flatMap(topicTags))], session) : new Map();
    const items = docs.map(topic => ({
      ...topicOption(topic, lang, now, owners),
      ...(groups.length ? membership(groups[0], topic) : {}),
    }));
    return { lang, ...(groups.length ? { logicalStoryId: String(groupSource(groups[0])._id) } : {}),
      items, ...pagination(total, page, limit, items.length) };
  });
}

async function listAttachedStories(id, query) {
  const options = storyQuery(query, 'attached');
  return inArticleTransaction(async session => {
    const topic = await findAdminTopic(id, session);
    const groups = await readGroups({ tags: { $in: topicTags(topic) } }, session);
    return pageGroups(groups, topic, options).result;
  });
}

// Literal, bounded metadata matching; this is not a full-text search engine.
function boundedText(path, limit) {
  const string = value => ({ $cond: [{ $eq: [{ $type: value }, 'string'] }, value, ''] });
  const raw = `$${path}`;
  return { $toLower: { $substrCP: [{ $cond: [
    { $isArray: raw },
    { $reduce: { input: { $slice: [{ $cond: [{ $isArray: raw }, raw, []] }, 100] }, initialValue: '',
      in: { $concat: ['$$value', ' ', { $substrCP: [string('$$this'), 0, 200] }] } } },
    string(raw),
  ] }, 0, limit] } };
}

function evidence(terms, discovery) {
  const fields = ['title', 'slug', 'category', 'tags', 'keywords', 'seo.metaTitle', 'seo.metaDescription',
    'seo.keywords', 'seo.metaKeywords', ...SUPPORTED_LANGS.flatMap(lang => [`slugs.${lang}`, `translations.${lang}.title`])];
  if (discovery) fields.push('description', 'summary', 'content',
    ...SUPPORTED_LANGS.flatMap(lang => [`translations.${lang}.summary`, `translations.${lang}.content`]));
  return fields.flatMap(field => terms.map(term => ({
    field, term,
    condition: { $gte: [{ $indexOfCP: [
      boundedText(field, field === 'content' || field.endsWith('.content') ? CONTENT_LIMIT : TEXT_LIMIT),
      { $literal: term.toLowerCase() },
    ] }, 0] },
  })));
}

function candidateTerms(topic, q) {
  if (q) return [q];
  const text = [...SUPPORTED_LANGS.map(lang => topic.name[lang]), topic.slug, ...topicTags(topic).map(tag => tag.replace(/^topic:/, ''))];
  return [...new Set(text.flatMap(value => String(value).toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u))
    .filter(term => term.length >= 2))].slice(0, MAX_TERMS);
}

async function searchStories(id, query, discovery = false) {
  const options = storyQuery(query, discovery ? 'candidates' : 'search');
  return inArticleTransaction(async session => {
    const topic = await findAdminTopic(id, session);
    const terms = discovery ? candidateTerms(topic, options.q) : [options.q];
    if (!terms.length) throw invalid('Supply q because this topic has no usable discovery terms');
    const checks = evidence(terms, discovery);
    const groups = await readGroups({ $expr: { $or: checks.map(check => check.condition) } }, session);
    const eligible = discovery ? groups.filter(members => !membership(members, topic).attached) : groups;
    const { selected, result } = pageGroups(eligible, topic, options);
    if (discovery && selected.length) {
      const ids = selected.flatMap(row => row.members.map(doc => doc._id));
      const matches = await News.aggregate([
        { $match: { _id: { $in: ids } } },
        { $project: { reasons: { $filter: {
          input: checks.map(check => ({ $cond: [check.condition,
            { field: { $literal: check.field }, term: { $literal: check.term } }, null] })),
          as: 'reason', cond: { $ne: ['$$reason', null] },
        } } } },
      ]).option({ session, maxTimeMS: QUERY_MS, allowDiskUse: false, collation: COLLATION }).exec();
      for (const row of selected) {
        const variantIds = new Set(row.card.variantIds);
        const reasons = matches.filter(match => variantIds.has(String(match._id))).flatMap(match => match.reasons);
        row.card.matchReasons = [...new Map(reasons.map(reason => [`${reason.field}:${reason.term}`, reason])).values()].slice(0, 5);
        if (!row.card.matchReasons.length) throw new Error('Candidate evidence changed during the topic read');
      }
    }
    return { ...result, ...(discovery ? { suggestionOnly: true, terms } : { q: options.q }) };
  });
}

async function changeMembership(id, body, action) {
  const { storyIds } = selectionInput.parse(body);
  return inArticleTransaction(async (session, transaction) => {
    const topic = await findAdminTopic(id, session);
    const owners = await tagOwners(topicTags(topic), session);
    const safeTags = safeMembershipTags(topic, owners);
    const membershipTag = preferredMembershipTag(topic, owners);
    const groups = await selectedGroups(storyIds, session);
    const previousDocs = groups.flat();
    if (action === 'attach' && !membershipTag) {
      throw conflict('Assign a unique configured topic: tag before attaching stories. Founder review is required.', 'UNSAFE_TOPIC_TAGS');
    }
    if (action === 'detach' && previousDocs.some(doc => articleTags(doc)
      .some(tag => topicTags(topic).includes(tag) && !safeTags.includes(tag)))) {
      throw conflict('Detaching would remove a shared topic tag or ordinary metadata. Founder review is required.', 'UNSAFE_TOPIC_TAGS');
    }
    // Serialize membership against topic configuration and edition creation/lifecycle writes.
    const topicGuard = await EditorialTopic.updateOne(
      { _id: topic._id, __v: topic.__v ?? null }, { $inc: { __v: 1 } }, { session, timestamps: false }
    );
    if (!topicGuard.acknowledged || topicGuard.matchedCount !== 1) throw conflict('Topic changed. Reload and retry.');
    const tagsUpdate = action === 'attach'
      ? { $addToSet: { tags: membershipTag } }
      : { $pull: { tags: { $in: safeTags } } };
    const newsUpdate = await News.updateMany(
      { _id: { $in: previousDocs.map(doc => doc._id) } },
      { ...tagsUpdate, $inc: { syncVersion: 1 } }, { session, timestamps: false, collation: COLLATION }
    );
    if (!newsUpdate.acknowledged || newsUpdate.matchedCount !== previousDocs.length) {
      throw conflict('Story editions changed. Reload and retry.');
    }
    const copyUpdate = await PublicArticle.updateMany(
      buildPublicCopyFilter(previousDocs), tagsUpdate, { session, timestamps: false, collation: COLLATION }
    );
    if (!copyUpdate.acknowledged) throw new Error('Public topic membership update was not acknowledged');
    let changedVariants = 0;
    const updatedGroups = groups.map(members => members.map(doc => {
      const before = articleTags(doc);
      const tags = action === 'attach'
        ? (before.includes(membershipTag) ? before : [...before, membershipTag])
        : before.filter(tag => !safeTags.includes(tag));
      if (JSON.stringify(before) !== JSON.stringify(tags)) changedVariants += 1;
      return { ...doc, tags };
    }));
    const result = {
      topicId: String(topic._id), action, unit: 'logical-story', committed: true,
      count: groups.length, changedVariants,
      items: updatedGroups.map(members => storyCard(members, topic, 'gu')),
    };
    transaction.afterCommit.push(async () => {
      result.revalidation = await invalidateArticleContent(updatedGroups.flat(), {
        previousDocs, topicSlugs: [topic.slug], reason: `topic_membership_${action}`, publicVisibilityRemoved: action === 'detach',
      });
    });
    return result;
  });
}

module.exports = {
  MAX_STORY_IDS, MAX_DOCUMENTS, TEXT_LIMIT, CONTENT_LIMIT,
  listAvailableTopics, listAttachedStories,
  searchTopicStories: (id, query) => searchStories(id, query),
  discoverCandidateStories: (id, query) => searchStories(id, query, true),
  attachStories: (id, body) => changeMembership(id, body, 'attach'),
  detachStories: (id, body) => changeMembership(id, body, 'detach'),
};
