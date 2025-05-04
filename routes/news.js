// const express = require('express');
// const router = express.Router();
// const { createNews, getNews } = require('../controllers/newsController');

// router.post('/news', createNews);
// router.get('/news', getNews);

// module.exports = router;

const express = require('express');
const router = express.Router();
const { createNews, getNews } = require('../controllers/newsController');

router.route('/news').post(createNews).get(getNews);

module.exports = router;
