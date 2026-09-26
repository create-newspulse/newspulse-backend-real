const mongoose = require('mongoose');

const AuthorSnapshotSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: function () { return this.parent().enabled; }, maxlength: 160 },
  publicDesignation: { type: String, trim: true, maxlength: 160, default: undefined },
  photoUrl: { type: String, trim: true, maxlength: 2048, default: undefined },
  shortBio: { type: String, trim: true, maxlength: 600, default: undefined },
}, { _id: false });

const AuthorBylineSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  snapshotCapturedAt: { type: Date, default: undefined },
  snapshot: {
    type: AuthorSnapshotSchema,
    required: function () { return this.enabled; },
    default: undefined,
  },
}, { _id: false });

module.exports = AuthorBylineSchema;