const mongoose = require('mongoose');
const Curation = require('../models/PulseDialogueCuration');
const Contributor = require('../models/Contributor');
const News = require('../models/News');
const { buildContributorProfileSummary } = require('./pulseDialogue.service');
const { getPublicContentGroupKey } = require('./publicCategoryListing.service');
const discovery = require('./pulseDialogueDiscovery.service');

const VOICE_SELECT = '_id slug canonicalName photo.url publicDesignation shortBio status profileVisible';
const voiceFilter = { status: 'active', profileVisible: true };

async function getConfiguration() {
  return await Curation.findById('pulse-dialogue').maxTimeMS(discovery.QUERY_MS).lean()
    || { featuredDialogue: [], featuredVoices: [], updatedAt: null };
}

function orderedIds(body, field) {
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body[field]) || body[field].length > 6) {
    throw discovery.invalid(`Expected ${field}, an ordered array of at most six IDs`);
  }
  const ids = body[field];
  if (ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
    throw discovery.invalid('IDs must be valid and unique');
  }
  return ids.map(id => new mongoose.Types.ObjectId(id));
}

async function setList(kind, body) {
  const isDialogue = kind === 'featuredDialogue';
  const ids = orderedIds(body, isDialogue ? 'articleIds' : 'contributorIds');
  const filter = isDialogue ? discovery.publicFilter({ _id: { $in: ids } }) : { ...voiceFilter, _id: { $in: ids } };
  const docs = ids.length ? await (isDialogue ? News : Contributor).find(filter)
    .select(isDialogue ? '_id translationKey translationGroupId slug slugs' : '_id')
    .maxTimeMS(discovery.QUERY_MS).limit(6).lean() : [];
  if (docs.length !== ids.length) throw discovery.invalid('Every selected target must be publicly eligible');
  if (isDialogue && new Set(docs.map(getPublicContentGroupKey)).size !== docs.length) {
    throw discovery.invalid('Select each story only once, including its translation editions');
  }
  await Curation.findByIdAndUpdate('pulse-dialogue', { $set: { [kind]: ids } },
    { upsert: true, new: true, runValidators: true, maxTimeMS: discovery.QUERY_MS });
  return getAdminConfiguration();
}

async function getAdminConfiguration() {
  const configuration = await getConfiguration();
  const articleIds = configuration.featuredDialogue.slice(0, 6);
  const contributorIds = configuration.featuredVoices.slice(0, 6);
  const [articles, contributors] = await Promise.all([
    articleIds.length ? News.find({ _id: { $in: articleIds } }).select('_id title slug category status').limit(6).maxTimeMS(discovery.QUERY_MS).lean() : [],
    contributorIds.length ? Contributor.find({ _id: { $in: contributorIds } }).select(VOICE_SELECT).limit(6).maxTimeMS(discovery.QUERY_MS).lean() : [],
  ]);
  return { featuredDialogue: articleIds.map(id => {
    const doc = articles.find(article => String(article._id) === String(id));
    return { id: String(id), title: doc?.title || null, slug: doc?.slug || null, status: doc?.status || null, missing: !doc };
  }), featuredVoices: contributorIds.map(id => {
    const doc = contributors.find(contributor => String(contributor._id) === String(id));
    return { id: String(id), ...(doc ? buildContributorProfileSummary(doc) : { slug: null, name: null }),
      status: doc?.status || null, profileVisible: doc?.profileVisible === true, missing: !doc };
  }), updatedAt: configuration.updatedAt || null };
}

function discoveryPipeline(configuration, lang = 'gu') {
  const ids = configuration.featuredDialogue.slice(0, 6);
  const stages = discovery.groupStages('newest', lang);
  stages[0].$project['pulseDialogue.dialogueFormat'] = 1;
  stages[2].$group.format = { $first: '$pulseDialogue.dialogueFormat' };
  stages[2].$group.featuredOrder = { $min: { $cond: [{ $in: ['$_id', ids] }, { $indexOfArray: [ids, '$_id'] }, 6] } };
  return [{ $match: discovery.publicFilter() }, ...stages, { $facet: {
    featuredDialogue: [{ $match: { featuredOrder: { $lt: 6 } } }, { $sort: { featuredOrder: 1 } }, { $limit: 6 }],
    ...Object.fromEntries(Object.entries(discovery.FORMAT_GROUPS).map(([key, formats]) => [key,
      [{ $match: { format: { $in: formats } } }, { $limit: 4 }]])),
  } }];
}

async function getDiscovery(lang) {
  const configuration = await getConfiguration();
  const [selection = {}] = await discovery.aggregate(discoveryPipeline(configuration, lang));
  const groups = Object.values(selection).flat();
  const [cards, voices] = await Promise.all([
    discovery.hydrate(discovery.publicFilter(), groups, lang),
    configuration.featuredVoices.length ? Contributor.find({ ...voiceFilter, _id: { $in: configuration.featuredVoices.slice(0, 6) } })
      .select(VOICE_SELECT).limit(6).maxTimeMS(discovery.QUERY_MS).lean() : [],
  ]);
  const byKey = new Map(cards.map(card => [getPublicContentGroupKey(card), card]));
  const select = key => (selection[key] || []).map(group => byKey.get(group._id)).filter(Boolean);
  return { lang, featuredDialogue: select('featuredDialogue'),
    featuredVoices: configuration.featuredVoices.slice(0, 6).map(id => voices.find(voice => String(voice._id) === String(id)))
      .filter(Boolean).map(buildContributorProfileSummary),
    formatGroups: Object.fromEntries(Object.entries(discovery.FORMAT_GROUPS).map(([key, formats]) =>
      [key, select(key).filter(card => formats.includes(card.pulseDialogue?.dialogueFormat))])) };
}

module.exports = { orderedIds, getConfiguration, getAdminConfiguration, setList, discoveryPipeline, getDiscovery };