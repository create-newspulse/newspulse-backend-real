const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');

const PulseDialogueSeriesSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, immutable: true, trim: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, default: null, trim: true, maxlength: 1000 },
  ownerContributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contributor', default: null },
  profileVisible: { type: Boolean, default: false },
}, { timestamps: true });

PulseDialogueSeriesSchema.pre('validate', function preValidate(next) {
  if (this.isNew) this.slug = this.slug
    ? slugifyUnicode(this.slug, { maxLength: 140 })
    : (slugifyUnicode(this.title, { maxLength: 120 }) || 'series');
  next();
});

module.exports = mongoose.models.PulseDialogueSeries || mongoose.model('PulseDialogueSeries', PulseDialogueSeriesSchema);