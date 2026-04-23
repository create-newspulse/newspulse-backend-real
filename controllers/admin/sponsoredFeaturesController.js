const mongoose = require('mongoose');

const SponsoredFeature = require('../../models/SponsoredFeature');
const News = require('../../models/News');
const Article = require('../../models/Article');
const { bumpPublicConfigVersion } = require('../../services/publicConfigVersion.service');
const {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  SPONSORED_FEATURE_TYPE,
  isItemInSchedule,
  normalizePlacementKey,
  placementKeyToPlacement,
  normalizeOptionalString,
  normalizeOptionalBoolean,
  parseOptionalDate,
  parseOptionalNumber,
  validateOptionalUrlLike,
  normalizeCoverImageInput,
} = require('../../lib/sponsoredFeatures');
const {
  findLinkedArticleByAnyId,
  buildLinkedArticleDto,
  isSponsoredArticleDoc,
  isComboCampaignEnabled,
  deriveEffectiveDestination,
  getActiveSponsoredFeatureByPlacement,
} = require('../../services/sponsoredFeatures.service');
const { buildPubliclyVisiblePublicArticleFilter } = require('../../services/publicArticleVisibility.service');

const DEFAULT_SPONSORED_FEATURE_PLACEMENT_KEY = SPONSORED_FEATURE_PLACEMENT_KEYS[0];

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function syncLinkedArticleFeatureReference({ featureId, prevLinkedArticleId, nextLinkedArticleId }) {
  const oldId = String(prevLinkedArticleId || '').trim();
  const newId = String(nextLinkedArticleId || '').trim();

  try {
    if (oldId && oldId !== newId) {
      await Promise.all([
        News.updateMany({ _id: oldId, sponsorFeatureLinkedId: featureId }, { $set: { sponsorFeatureLinkedId: null } }),
        Article.updateMany(
          {
            $or: [{ _id: oldId }, { sourceNewsId: oldId }],
            sponsorFeatureLinkedId: featureId,
          },
          { $set: { sponsorFeatureLinkedId: null } }
        ),
      ]);
    }

    if (newId) {
      await Promise.all([
        News.updateMany({ _id: newId }, { $set: { sponsorFeatureLinkedId: featureId } }),
        Article.updateMany({ $or: [{ _id: newId }, { sourceNewsId: newId }] }, { $set: { sponsorFeatureLinkedId: featureId } }),
      ]);
    }
  } catch (_) {
    // Best-effort only. Sponsored Feature should not fail because of back-reference sync.
  }
}

function buildPlacementScopedFilter(placementKey, extra = {}) {
  const normalizedPlacementKey = normalizePlacementKey(placementKey);
  const placement = normalizedPlacementKey ? placementKeyToPlacement(normalizedPlacementKey) : null;
  const filter = { ...extra };

  if (!normalizedPlacementKey) return filter;

  filter.$or = [
    { placementKey: normalizedPlacementKey },
    ...(placement ? [{ placement }] : []),
  ];

  return filter;
}

async function deactivateOtherActiveSponsoredFeatures({ placementKey, keepId }) {
  const normalizedPlacementKey = normalizePlacementKey(placementKey);
  if (!normalizedPlacementKey) return;

  const filter = buildPlacementScopedFilter(normalizedPlacementKey, { isActive: true });
  if (keepId) {
    filter._id = { $ne: keepId };
  }

  await SponsoredFeature.updateMany(filter, { $set: { isActive: false } });
}

function toAdminLiveTargetDto(featureDoc, linkedArticle) {
  if (!featureDoc) return null;
  const linkedArticleDto = linkedArticle ? buildLinkedArticleDto(linkedArticle) : null;
  const targetUrl = deriveEffectiveDestination(featureDoc, linkedArticleDto);
  const usesLinkedArticle = Boolean(
    isComboCampaignEnabled(featureDoc)
    && linkedArticleDto
    && linkedArticleDto.path
    && targetUrl
    && targetUrl === linkedArticleDto.path
  );

  return {
    featureId: String(featureDoc._id),
    sponsorName: featureDoc.sponsorName || null,
    headline: featureDoc.headline || null,
    targetType: usesLinkedArticle ? 'linked_article' : (targetUrl ? 'external_url' : null),
    targetUrl,
    linkedArticle: usesLinkedArticle && linkedArticleDto
      ? {
          id: linkedArticleDto.id || null,
          slug: linkedArticleDto.slug || null,
          path: linkedArticleDto.path || null,
        }
      : null,
  };
}

function buildEligibleSponsoredArticleFilter({ now = new Date() } = {}) {
  const filter = buildPubliclyVisiblePublicArticleFilter({ now });
  filter.$and = (filter.$and || []).concat([
    {
      $or: [
        { isSponsoredArticle: true },
        { isSponsored: true },
      ],
    },
  ]);
  return filter;
}

function toEligibleSponsoredArticleDto(doc) {
  const linkedArticle = buildLinkedArticleDto(doc);
  return {
    id: linkedArticle && linkedArticle.id ? linkedArticle.id : null,
    title: doc && doc.title ? doc.title : null,
    slug: linkedArticle && linkedArticle.slug ? linkedArticle.slug : null,
    path: linkedArticle && linkedArticle.path ? linkedArticle.path : null,
    sponsorName: doc && doc.sponsorName ? doc.sponsorName : null,
    sponsorFeatureEligible: doc && doc.sponsorFeatureEligible === true,
    sponsorFeatureLinkedId: doc && doc.sponsorFeatureLinkedId ? String(doc.sponsorFeatureLinkedId) : null,
    publishedAt: doc && doc.publishedAt ? doc.publishedAt : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
    coverImage: doc && doc.coverImage ? doc.coverImage : null,
  };
}

function buildCommercialState(featureDoc, linkedArticle, linkedLiveArticle, { now = new Date() } = {}) {
  const sponsoredFeatureLive = Boolean(featureDoc && featureDoc.isActive === true && isItemInSchedule(featureDoc, now));
  const sponsoredArticleLive = Boolean(linkedLiveArticle && isSponsoredArticleDoc(linkedLiveArticle));
  const hasLinkedSponsoredArticle = Boolean(featureDoc && featureDoc.linkedArticleId);
  const comboEnabled = isComboCampaignEnabled(featureDoc);
  const comboLive = Boolean(comboEnabled && sponsoredFeatureLive && sponsoredArticleLive && hasLinkedSponsoredArticle);

  return {
    sponsoredFeature: {
      product: 'sponsored_feature',
      commercialRole: 'reach',
      frontendSurface: 'homepage_sponsored_card',
      homepagePlacementOnly: true,
      independentlyControlled: true,
      isLive: sponsoredFeatureLive,
    },
    sponsoredArticle: {
      product: 'sponsored_article',
      commercialRole: 'content_asset',
      frontendSurface: 'standalone_sponsored_article_page',
      independentlyControlled: true,
      isLinked: hasLinkedSponsoredArticle,
      isLive: sponsoredArticleLive,
      canRemainPublishedWithoutFeature: true,
    },
    comboCampaign: {
      product: 'combo_campaign',
      commercialRole: 'bundled_reach_and_depth',
      frontendSurface: 'bundle_only',
      isFrontendObject: false,
      isBundle: true,
      isEnabled: comboEnabled,
      isActive: comboLive,
      pricingRationale: 'homepage reach plus full sponsored article depth',
      components: {
        comboEnabled,
        sponsoredFeatureLive,
        sponsoredArticleLive,
      },
    },
    deliveryMode: comboEnabled && sponsoredArticleLive
      ? 'linked_sponsored_article'
      : (featureDoc && featureDoc.destinationUrl ? 'external_destination' : 'feature_only'),
    linkedRelationshipOptional: true,
    externalDestinationAvailable: Boolean(featureDoc && featureDoc.destinationUrl),
    linkedArticlePath: linkedArticle && linkedArticle.path ? linkedArticle.path : null,
  };
}

async function listEligibleSponsoredArticlesInternal({ now = new Date(), limit = 100 } = {}) {
  const docs = await Article.find(buildEligibleSponsoredArticleFilter({ now }))
    .select([
      'title',
      'summary',
      'slug',
      'slugs',
      'language',
      'originalLang',
      'publishedAt',
      'updatedAt',
      'coverImage',
      'isSponsored',
      'isSponsoredArticle',
      'sponsorName',
      'sponsorFeatureEligible',
      'sponsorFeatureLinkedId',
    ].join(' '))
    .sort({ sponsorFeatureEligible: -1, publishedAt: -1, updatedAt: -1 })
    .limit(limit)
    .lean();

  return (docs || []).map(toEligibleSponsoredArticleDto).filter((item) => item.id);
}

function toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, options = {}) {
  if (!doc) return null;
  const commercialState = buildCommercialState(doc, linkedArticle, linkedLiveArticle, options);
  return {
    id: String(doc._id),
    type: SPONSORED_FEATURE_TYPE,
    placement: placementKeyToPlacement(doc.placementKey) || doc.placement || null,
    sponsorName: doc.sponsorName || null,
    internalTitle: doc.internalTitle || null,
    internalCampaignName: doc.internalTitle || null,
    headline: doc.headline || null,
    summary: doc.summary || null,
    shortSummary: doc.summary || null,
    ctaText: doc.ctaText || null,
    destinationUrl: doc.destinationUrl || null,
    coverImage: doc.coverImage || null,
    isActive: doc.isActive === true,
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    placementKey: doc.placementKey || null,
    labelText: doc.labelText || 'Sponsored Feature',
    linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
    linkedSponsoredArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
    linkedArticleUrl: doc.linkedArticleUrl || null,
    comboCampaignIsActive: isComboCampaignEnabled(doc),
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    linkedArticle: linkedArticle ? buildLinkedArticleDto(linkedArticle) : null,
    commercialState,
  };
}

async function buildPayload(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const placementInput = b.placementKey !== undefined ? b.placementKey : b.placement;
  const placementKey = placementInput === undefined ? undefined : normalizePlacementKey(placementInput);
  const sponsorName = normalizeOptionalString(b.sponsorName);
  const internalTitle = normalizeOptionalString(b.internalTitle !== undefined ? b.internalTitle : b.internalCampaignName);
  const headline = normalizeOptionalString(b.headline);
  const summary = normalizeOptionalString(b.summary !== undefined ? b.summary : b.shortSummary);
  const ctaText = normalizeOptionalString(b.ctaText);
  const isActive = normalizeOptionalBoolean(b.isActive);
  const comboCampaignIsActive = normalizeOptionalBoolean(
    b.comboCampaignIsActive !== undefined
      ? b.comboCampaignIsActive
      : (b.comboCampaign && typeof b.comboCampaign === 'object' ? b.comboCampaign.isActive : undefined)
  );
  const labelText = normalizeOptionalString(b.labelText);
  const linkedArticleIdRaw = normalizeOptionalString(b.linkedArticleId !== undefined ? b.linkedArticleId : b.linkedSponsoredArticleId);
  const linkedArticleId = linkedArticleIdRaw && mongoose.Types.ObjectId.isValid(linkedArticleIdRaw)
    ? linkedArticleIdRaw
    : (linkedArticleIdRaw ? undefined : (b.linkedArticleId === undefined && b.linkedSponsoredArticleId === undefined ? undefined : null));

  if (placementInput !== undefined && !placementKey) {
    return { ok: false, status: 400, message: `placementKey must be one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` };
  }
  if (b.isActive !== undefined && isActive === undefined) {
    return { ok: false, status: 400, message: 'isActive must be a boolean' };
  }
  if ((b.comboCampaignIsActive !== undefined || (b.comboCampaign && Object.prototype.hasOwnProperty.call(b.comboCampaign, 'isActive'))) && comboCampaignIsActive === undefined) {
    return { ok: false, status: 400, message: 'comboCampaign.isActive must be a boolean' };
  }
  if ((b.linkedArticleId !== undefined || b.linkedSponsoredArticleId !== undefined) && linkedArticleId === undefined) {
    return { ok: false, status: 400, message: 'linkedArticleId must be a valid id' };
  }

  const destinationUrl = validateOptionalUrlLike(b.destinationUrl, 'destinationUrl');
  if (!destinationUrl.ok) return { ok: false, status: 400, message: destinationUrl.message };

  const linkedArticleUrl = validateOptionalUrlLike(b.linkedArticleUrl, 'linkedArticleUrl');
  if (!linkedArticleUrl.ok) return { ok: false, status: 400, message: linkedArticleUrl.message };

  const coverImage = normalizeCoverImageInput(b.coverImage);
  if (!coverImage.ok) return { ok: false, status: 400, message: coverImage.message };

  const startAt = parseOptionalDate(b.startAt, 'startAt');
  if (!startAt.ok) return { ok: false, status: 400, message: startAt.message };

  const endAt = parseOptionalDate(b.endAt, 'endAt');
  if (!endAt.ok) return { ok: false, status: 400, message: endAt.message };

  if (startAt.value && endAt.value && endAt.value.getTime() < startAt.value.getTime()) {
    return { ok: false, status: 400, message: 'endAt must be greater than or equal to startAt' };
  }

  const priority = parseOptionalNumber(b.priority, 'priority', partial ? undefined : 0);
  if (!priority.ok) return { ok: false, status: 400, message: priority.message };

  if (!partial) {
    for (const [field, value] of Object.entries({ sponsorName, internalTitle, headline, summary, ctaText })) {
      if (!value) return { ok: false, status: 400, message: `${field} is required` };
    }
    if (!placementKey) return { ok: false, status: 400, message: 'placementKey is required' };
    if (!coverImage.value || !coverImage.value.url) return { ok: false, status: 400, message: 'coverImage is required' };
    if (!destinationUrl.value && !linkedArticleId && !linkedArticleUrl.value) {
      return { ok: false, status: 400, message: 'destinationUrl or linkedArticleId or linkedArticleUrl is required' };
    }
  }

  let linkedArticle = null;
  if (linkedArticleId) {
    linkedArticle = await findLinkedArticleByAnyId(linkedArticleId, { publicOnly: true });
    if (!linkedArticle) {
      return { ok: false, status: 400, message: 'linkedArticleId must reference a published public article' };
    }
    if (!isSponsoredArticleDoc(linkedArticle)) {
      return { ok: false, status: 400, message: 'linkedArticleId must reference a published sponsored article' };
    }
  }

  return {
    ok: true,
    value: {
      ...(placementKey !== undefined ? { placementKey } : {}),
      ...(placementKey !== undefined ? { placement: placementKeyToPlacement(placementKey) } : {}),
      type: SPONSORED_FEATURE_TYPE,
      ...(sponsorName !== undefined ? { sponsorName } : {}),
      ...(internalTitle !== undefined ? { internalTitle } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(ctaText !== undefined ? { ctaText } : {}),
      ...(destinationUrl.value !== undefined ? { destinationUrl: destinationUrl.value } : {}),
      ...(coverImage.value !== undefined ? { coverImage: coverImage.value } : {}),
      ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
      ...(comboCampaignIsActive !== undefined ? { comboCampaign: { isActive: Boolean(comboCampaignIsActive) } } : (!partial ? { comboCampaign: { isActive: true } } : {})),
      ...(startAt.value !== undefined ? { startAt: startAt.value } : {}),
      ...(endAt.value !== undefined ? { endAt: endAt.value } : {}),
      ...(labelText !== undefined ? { labelText: labelText || 'Sponsored Feature' } : (!partial ? { labelText: 'Sponsored Feature' } : {})),
      ...(linkedArticleId !== undefined ? { linkedArticleId } : {}),
      ...(linkedArticleUrl.value !== undefined ? { linkedArticleUrl: linkedArticleUrl.value } : {}),
      ...(priority.value !== undefined ? { priority: priority.value === null ? 0 : priority.value } : {}),
    },
    linkedArticle,
  };
}

async function listSponsoredFeatures(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const placementRaw = req.query && (req.query.placementKey || req.query.placement) ? String(req.query.placementKey || req.query.placement) : '';
  const placementKey = placementRaw ? normalizePlacementKey(placementRaw) : null;
  if (placementRaw && !placementKey) {
    return res.status(400).json({ ok: false, message: `Invalid placementKey. Expected one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` });
  }

  const activeOnly = String(req.query && req.query.activeOnly || '').trim().toLowerCase();
  const filter = placementKey ? buildPlacementScopedFilter(placementKey) : {};
  if (activeOnly === '1' || activeOnly === 'true') filter.isActive = true;

  const now = new Date();
  const docs = await SponsoredFeature.find(filter).sort({ updatedAt: -1 }).lean();
  const items = await Promise.all((docs || []).map(async (doc) => {
    const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
    const linkedLiveArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: true, now }) : null;
    return toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, { now });
  }));

  return res.status(200).json({ ok: true, items });
}

async function listEligibleSponsoredArticles(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const limit = Math.min(Math.max(parseInt(String(req.query && req.query.limit || '100'), 10) || 100, 1), 250);
  const items = await listEligibleSponsoredArticlesInternal({ now: new Date(), limit });
  return res.status(200).json({ ok: true, items });
}

async function getSponsoredFeaturesDashboard(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const placementRaw = req.query && (req.query.placementKey || req.query.placement)
    ? String(req.query.placementKey || req.query.placement)
    : DEFAULT_SPONSORED_FEATURE_PLACEMENT_KEY;
  const placementKey = normalizePlacementKey(placementRaw);
  if (!placementKey) {
    return res.status(400).json({ ok: false, message: `Invalid placementKey. Expected one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` });
  }

  const filter = buildPlacementScopedFilter(placementKey);
  const now = new Date();
  const docs = await SponsoredFeature.find(filter).sort({ updatedAt: -1 }).lean();
  const items = await Promise.all((docs || []).map(async (doc) => {
    const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
    const linkedLiveArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: true, now }) : null;
    return toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, { now });
  }));

  const active = await getActiveSponsoredFeatureByPlacement(placementKey, { now });
  const eligibleSponsoredArticles = await listEligibleSponsoredArticlesInternal({ now, limit: 100 });

  return res.status(200).json({
    ok: true,
    placementKey,
    placement: placementKeyToPlacement(placementKey),
    items,
    activeCount: (docs || []).filter((doc) => doc && doc.isActive === true).length,
    liveTarget: active ? toAdminLiveTargetDto(active.feature, active.linkedArticle) : null,
    eligibleSponsoredArticles,
  });
}

async function getSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const doc = await SponsoredFeature.findById(id).lean();
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  const now = new Date();
  const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
  const linkedLiveArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: true, now }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, { now }) });
}

async function createSponsoredFeature(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const payload = await buildPayload(req.body, { partial: false });
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const created = await SponsoredFeature.create(payload.value);
  if (created && created.isActive === true) {
    await deactivateOtherActiveSponsoredFeatures({ placementKey: created.placementKey || created.placement, keepId: created._id });
  }
  await syncLinkedArticleFeatureReference({ featureId: created._id, prevLinkedArticleId: null, nextLinkedArticleId: created.linkedArticleId });
  bumpPublicConfigVersion().catch(() => {});

  return res.status(201).json({ ok: true, feature: toAdminSponsoredFeatureDto(created, payload.linkedArticle, payload.linkedArticle, { now: new Date() }) });
}

async function updateSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const existing = await SponsoredFeature.findById(id).lean();
  if (!existing) return res.status(404).json({ ok: false, message: 'Not found' });

  const payload = await buildPayload(req.body, { partial: true });
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const updated = await SponsoredFeature.findByIdAndUpdate(id, { $set: payload.value }, { new: true, runValidators: true });
  if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

  if (updated.isActive === true) {
    await deactivateOtherActiveSponsoredFeatures({ placementKey: updated.placementKey || updated.placement, keepId: updated._id });
  }

  await syncLinkedArticleFeatureReference({
    featureId: updated._id,
    prevLinkedArticleId: existing.linkedArticleId,
    nextLinkedArticleId: updated.linkedArticleId,
  });
  bumpPublicConfigVersion().catch(() => {});

  const now = new Date();
  const linkedArticle = updated.linkedArticleId ? await findLinkedArticleByAnyId(updated.linkedArticleId, { publicOnly: false }) : null;
  const linkedLiveArticle = updated.linkedArticleId ? await findLinkedArticleByAnyId(updated.linkedArticleId, { publicOnly: true, now }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(updated, linkedArticle, linkedLiveArticle, { now }) });
}

async function toggleSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const doc = await SponsoredFeature.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  const explicit = normalizeOptionalBoolean(req.body && req.body.isActive);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'isActive') && explicit === undefined) {
    return res.status(400).json({ ok: false, message: 'isActive must be a boolean' });
  }

  doc.isActive = explicit === null || explicit === undefined ? !doc.isActive : explicit;
  await doc.save();
  if (doc.isActive === true) {
    await deactivateOtherActiveSponsoredFeatures({ placementKey: doc.placementKey || doc.placement, keepId: doc._id });
  }
  bumpPublicConfigVersion().catch(() => {});

  const now = new Date();
  const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
  const linkedLiveArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: true, now }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, { now }) });
}

async function toggleSponsoredFeatureCombo(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const doc = await SponsoredFeature.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  const explicit = normalizeOptionalBoolean(req.body && req.body.isActive);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'isActive') && explicit === undefined) {
    return res.status(400).json({ ok: false, message: 'isActive must be a boolean' });
  }

  doc.comboCampaign = doc.comboCampaign && typeof doc.comboCampaign === 'object' ? doc.comboCampaign : {};
  doc.comboCampaign.isActive = explicit === null || explicit === undefined
    ? !isComboCampaignEnabled(doc)
    : explicit;
  await doc.save();
  bumpPublicConfigVersion().catch(() => {});

  const now = new Date();
  const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
  const linkedLiveArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: true, now }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(doc, linkedArticle, linkedLiveArticle, { now }) });
}

async function deleteSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const existing = await SponsoredFeature.findByIdAndDelete(id).lean();
  if (!existing) return res.status(404).json({ ok: false, message: 'Not found' });

  await syncLinkedArticleFeatureReference({ featureId: id, prevLinkedArticleId: existing.linkedArticleId, nextLinkedArticleId: null });
  bumpPublicConfigVersion().catch(() => {});

  return res.status(200).json({ ok: true, deleted: true });
}

module.exports = {
  listSponsoredFeatures,
  listEligibleSponsoredArticles,
  getSponsoredFeaturesDashboard,
  getSponsoredFeature,
  createSponsoredFeature,
  updateSponsoredFeature,
  toggleSponsoredFeature,
  toggleSponsoredFeatureCombo,
  deleteSponsoredFeature,
};