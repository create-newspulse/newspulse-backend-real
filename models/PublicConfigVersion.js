const mongoose = require('mongoose');

const PublicConfigVersionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'public' },
    version: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

PublicConfigVersionSchema.pre('save', function onSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.PublicConfigVersion || mongoose.model('PublicConfigVersion', PublicConfigVersionSchema);