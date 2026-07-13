const mongoose = require('mongoose');

const LANGUAGE_VALUES = ['Gujarati', 'Hindi', 'English'];
const BULLETIN_TYPE_VALUES = ['Early Morning', 'Morning', 'Noon', 'Afternoon', 'Evening', 'Prime Time', 'Night', 'Breaking'];
const DURATION_MINUTES_VALUES = [3, 5, 10, 15, 25, 30];
const PUBLIC_LABEL_VALUES = ['AIRA BULLETIN', 'AIRA BULLETIN • ON AIR', 'SCHEDULED', 'REPLAY', 'BREAKING BULLETIN'];
const VISUAL_TYPE_VALUES = ['anchor_only', 'image', 'video', 'map', 'headline_card', 'timeline', 'breaking_banner', 'sponsor_card'];
const STATUS_VALUES = ['Draft', 'Ready for Review', 'Approved', 'Rejected', 'Archived'];

const visualBlockSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, default: '' },
    startTime: { type: String, trim: true, default: '' },
    endTime: { type: String, trim: true, default: '' },
    visualType: { type: String, enum: VISUAL_TYPE_VALUES, default: 'anchor_only' },
    title: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    sourceCredit: { type: String, trim: true, default: '' },
    mediaUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const AiraBulletinSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, required: true },
    language: { type: String, enum: LANGUAGE_VALUES, required: true, index: true },
    bulletinType: { type: String, enum: BULLETIN_TYPE_VALUES, default: 'Morning', index: true },
    durationMinutes: { type: Number, enum: DURATION_MINUTES_VALUES, default: 5 },
    scheduleDate: { type: String, trim: true, default: '' },
    scheduleTime: { type: String, trim: true, default: '' },
    endTime: { type: String, trim: true, default: '' },
    publicLabel: { type: String, enum: PUBLIC_LABEL_VALUES, default: 'AIRA BULLETIN' },
    anchorName: { type: String, trim: true, default: '' },
    anchorFace: { type: String, trim: true, default: '' },
    dressStyle: { type: String, trim: true, default: '' },
    voiceStyle: { type: String, trim: true, default: '' },
    tone: { type: String, trim: true, default: '' },
    studioTemplate: { type: String, trim: true, default: '' },
    script: { type: String, trim: true, default: '' },
    audioUrl: { type: String, trim: true, default: '' },
    videoUrl: { type: String, trim: true, default: '' },
    visualBlocks: { type: [visualBlockSchema], default: [] },
    status: { type: String, enum: STATUS_VALUES, default: 'Draft', index: true },
    publishStatus: { type: String, trim: true, default: '', index: true },
    liveTvAssociation: { type: mongoose.Schema.Types.Mixed, default: null },
    createdBy: { type: String, trim: true, default: '' },
    updatedBy: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

AiraBulletinSchema.index({ createdAt: -1 });

AiraBulletinSchema.statics.enums = Object.freeze({
  LANGUAGE_VALUES,
  BULLETIN_TYPE_VALUES,
  DURATION_MINUTES_VALUES,
  PUBLIC_LABEL_VALUES,
  VISUAL_TYPE_VALUES,
  STATUS_VALUES,
});

module.exports = mongoose.models.AiraBulletin || mongoose.model('AiraBulletin', AiraBulletinSchema);