const mongoose = require('mongoose');
const News = require('../models/News');

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function getIncomingLang(body) {
  // Prefer `lang` but accept legacy `language` too.
  return normalizeLanguage(body?.lang) || normalizeLanguage(body?.language);
}

function normalizeTranslationGroupId(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

exports.createNews = async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }

    // Multilingual publishing (Option A+)
    // Backward compatible: if invalid/missing, fall back to defaults.
    const lang = getIncomingLang(body);
    if (lang) {
      body.lang = lang;
      body.language = lang;
    } else {
      if (body.lang !== undefined) delete body.lang;
      if (body.language !== undefined) delete body.language;
    }

    const translationGroupId = normalizeTranslationGroupId(body.translationGroupId);
    body.translationGroupId = translationGroupId || new mongoose.Types.ObjectId().toString();

    const news = new News(body);
    await news.save();
    res.status(201).json({ message: "News created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getNews = async (req, res) => {
  try {
    const newsList = await News.find().sort({ date: -1 });
    const items = (newsList || []).map(doc => {
      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      obj.coverImageUrl = obj.coverImageUrl || obj.imageURL || null;
      obj.lang = obj.lang || obj.language || 'gu';
      obj.language = obj.language || obj.lang || 'gu';
      return obj;
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateNews = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const body = { ...(req.body || {}) };
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }

    const lang = getIncomingLang(body);
    if (lang) {
      body.lang = lang;
      body.language = lang;
    } else {
      if (body.lang !== undefined) delete body.lang;
      if (body.language !== undefined) delete body.language;
    }

    const translationGroupId = normalizeTranslationGroupId(body.translationGroupId);
    if (translationGroupId) body.translationGroupId = translationGroupId;
    else if (body.translationGroupId !== undefined) delete body.translationGroupId;

    const updated = await News.findByIdAndUpdate(id, body, { new: true, runValidators: false });
    if (!updated) return res.status(404).json({ error: 'Not found' });

    return res.json({ message: 'News updated successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
