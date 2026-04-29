const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
	getViralVideosSettings,
	updateViralVideosSettings,
	listAdminViralVideos,
	createAdminViralVideo,
	getAdminViralVideoById,
	updateAdminViralVideo,
	deleteAdminViralVideo,
	uploadViralVideoFile,
} = require('../controllers/adminViralVideosController');

const router = express.Router();

router.use('/viral-videos', requireAdminAuth);

router.get('/viral-videos/settings', getViralVideosSettings);
router.put('/viral-videos/settings', updateViralVideosSettings);
router.get('/viral-videos', listAdminViralVideos);
router.post('/viral-videos', createAdminViralVideo);
router.post('/viral-videos/upload', uploadViralVideoFile);
router.post('/viral-videos/upload-video', uploadViralVideoFile);
router.get('/viral-videos/:id', getAdminViralVideoById);
router.put('/viral-videos/:id', updateAdminViralVideo);
router.patch('/viral-videos/:id', updateAdminViralVideo);
router.delete('/viral-videos/:id', deleteAdminViralVideo);

module.exports = router;
