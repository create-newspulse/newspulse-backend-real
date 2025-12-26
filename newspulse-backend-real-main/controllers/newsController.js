const News = require('../models/News');

exports.createNews = async (req, res) => {
  try {
    const body = req.body || {};
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }
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
      return obj;
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
