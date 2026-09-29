const mongoose = require('mongoose');

const boundedUnique = values => values.length <= 6 && new Set(values.map(String)).size === values.length;
const schema = new mongoose.Schema({
  _id: { type: String, default: 'pulse-dialogue' },
  featuredDialogue: { type: [mongoose.Schema.Types.ObjectId], default: [], validate: boundedUnique },
  featuredVoices: { type: [mongoose.Schema.Types.ObjectId], default: [], validate: boundedUnique },
}, { timestamps: true, autoIndex: false, autoCreate: false });

module.exports = mongoose.models.PulseDialogueCuration || mongoose.model('PulseDialogueCuration', schema);