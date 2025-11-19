const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  content: String,
  tags: [String],
  category: String,
  date: { type: Date, default: Date.now },
  imageURL: String,
  views: { type: Number, default: 0 },
});

module.exports = mongoose.model('News', newsSchema);
