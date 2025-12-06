const mongoose = require('mongoose');

const SystemSettingsSchema = new mongoose.Schema({
  communityMyStoriesEnabled: { type: Boolean, default: true },
  // reserved for future flags
}, { timestamps: true });

SystemSettingsSchema.statics.getSingleton = async function() {
  const Model = this;
  let doc = await Model.findOne({});
  if (!doc) {
    doc = await Model.create({});
  }
  return doc;
};

module.exports = mongoose.models.SystemSettings || mongoose.model('SystemSettings', SystemSettingsSchema);
