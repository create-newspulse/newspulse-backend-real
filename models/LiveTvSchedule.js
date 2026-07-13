const mongoose = require('mongoose');

const SOURCE_TYPE_VALUES = ['youtube_live', 'custom_embed', 'aira_bulletin', 'offline_replay', 'scheduled_program', 'breaking_bulletin', 'sponsored_program', 'maintenance'];
const LABEL_VALUES = ['LIVE', 'AIRA BULLETIN • ON AIR', 'SCHEDULED', 'REPLAY', 'BREAKING BULLETIN', 'SPONSORED PROGRAM', 'COMING SOON'];
const STATUS_VALUES = ['draft', 'scheduled', 'active', 'completed', 'disabled'];
const PRIORITY_VALUES = ['normal', 'high', 'breaking'];
const REPEAT_VALUES = ['none', 'daily', 'weekly'];

const LiveTvScheduleSchema = new mongoose.Schema(
  {
    programTitle: { type: String, trim: true, required: true },
    sourceType: { type: String, enum: SOURCE_TYPE_VALUES, required: true, index: true },
    label: { type: String, enum: LABEL_VALUES, required: true },
    date: { type: String, trim: true, required: true, index: true },
    startTime: { type: String, trim: true, required: true },
    endTime: { type: String, trim: true, default: '' },
    durationMinutes: { type: Number, default: null },
    selectedAiraBulletinId: { type: String, trim: true, default: '' },
    videoUrl: { type: String, trim: true, default: '' },
    embedUrl: { type: String, trim: true, default: '' },
    sponsorName: { type: String, trim: true, default: '' },
    sponsorLabel: { type: String, trim: true, default: '' },
    status: { type: String, enum: STATUS_VALUES, default: 'draft', index: true },
    priority: { type: String, enum: PRIORITY_VALUES, default: 'normal', index: true },
    repeat: { type: String, enum: REPEAT_VALUES, default: 'none' },
    createdBy: { type: String, trim: true, default: '' },
    updatedBy: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

LiveTvScheduleSchema.index({ date: 1, startTime: 1 });
LiveTvScheduleSchema.index({ status: 1, sourceType: 1, priority: 1 });

LiveTvScheduleSchema.statics.enums = Object.freeze({
  SOURCE_TYPE_VALUES,
  LABEL_VALUES,
  STATUS_VALUES,
  PRIORITY_VALUES,
  REPEAT_VALUES,
});

module.exports = mongoose.models.LiveTvSchedule || mongoose.model('LiveTvSchedule', LiveTvScheduleSchema);