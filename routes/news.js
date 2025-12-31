// const express = require('express');
// const router = express.Router();
// const { createNews, getNews } = require('../controllers/newsController');

// router.post('/news', createNews);
// router.get('/news', getNews);

// module.exports = router;

const express = require('express');
const router = express.Router();
const { createNews, getNews, updateNews } = require('../controllers/newsController');

// Primary root path so mounted at /api/news gives /api/news (list/create)
router.route('/').post(createNews).get(getNews);
// Backward compatibility path (legacy double /news/news)
router.route('/news').post(createNews).get(getNews);

// Update by id (non-breaking addition)
router.route('/:id').put(updateNews).patch(updateNews);

module.exports = router;
