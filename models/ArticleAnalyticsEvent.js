const mongoose = require('mongoose');

const DISCOVERY_EVENT_TYPES = ['contributor_profile_click', 'series_click', 'featured_dialogue_click', 'featured_voice_click'];

const EVENT_TYPES = [
  'view',
  'engaged_read',
  'scroll_25',
  'scroll_50',
  'scroll_75',
  'scroll_100',
  'heartbeat',
  ...DISCOVERY_EVENT_TYPES,
];

const articleAnalyticsEventSchema = new mongoose.Schema(
  {
    articleId: { type: mongoose.Schema.Types.ObjectId, required() { return !DISCOVERY_EVENT_TYPES.includes(this.eventType); }, index: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetType: { type: String, enum: ['article', 'contributor', 'series'], default: undefined },
    slug: { type: String, default: null, index: true },
    category: { type: String, default: null, index: true },
    language: { type: String, default: null, index: true },

    eventType: { type: String, enum: EVENT_TYPES, required: true, index: true },

    visitorId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },

    source: { type: String, default: 'unknown', index: true },
    referrer: { type: String, default: null },
    deviceType: { type: String, default: null, index: true },

    country: { type: String, default: null, index: true },
    state: { type: String, default: null, index: true },
    city: { type: String, default: null, index: true },

    userAgentHash: { type: String, default: null, index: true },
    ipHash: { type: String, default: null, index: true },

    readTimeSec: { type: Number, default: null },
    scrollPercent: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

articleAnalyticsEventSchema.index({ articleId: 1, createdAt: -1 });
articleAnalyticsEventSchema.index({ createdAt: -1 });
articleAnalyticsEventSchema.index({ articleId: 1, eventType: 1, createdAt: -1 });
articleAnalyticsEventSchema.index({ articleId: 1, visitorId: 1, sessionId: 1, eventType: 1, createdAt: -1 });

module.exports = mongoose.model('ArticleAnalyticsEvent', articleAnalyticsEventSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.DISCOVERY_EVENT_TYPES = DISCOVERY_EVENT_TYPES;
