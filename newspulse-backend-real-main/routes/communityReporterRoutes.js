const express = require('express');
const { submitStory, listStoriesByReporter } = require('../controllers/communityReporterController');

const router = express.Router();

router.post('/submit', submitStory);
router.get('/my-stories', listStoriesByReporter);

module.exports = router;
