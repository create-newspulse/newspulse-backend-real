const News = require('../models/News');

exports.createNews = async (req, res) => {
  try {
    const news = new News(req.body);
    await news.save();
    res.status(201).json({ message: "News created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getNews = async (req, res) => {
  try {
    const newsList = await News.find().sort({ date: -1 });
    res.json(newsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
