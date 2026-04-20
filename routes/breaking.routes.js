const express = require('express');

const noCache = require('../middleware/noCache');
const { listPublicBreakingNews } = require('../controllers/publicNewsController');

const router = express.Router();

router.get('/', noCache, listPublicBreakingNews);

module.exports = router;