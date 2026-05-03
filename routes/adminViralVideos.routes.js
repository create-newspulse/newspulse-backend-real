const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { coverUpload } = require('./uploads.routes');
const {
	getViralVideosSettings,
	updateViralVideosSettings,
	listAdminViralVideos,
	createAdminViralVideo,
	getAdminViralVideoById,
	updateAdminViralVideo,
	deleteAdminViralVideo,
	uploadViralVideoThumbnailFile,
	uploadViralVideoFile,
	uploadViralVideoMediaFile,
	publishAdminViralVideo,
	unpublishAdminViralVideo,
	previewAdminViralVideo,
	updateAdminViralVideoStatus,
} = require('../controllers/adminViralVideosController');

const router = express.Router();

router.use('/viral-videos', requireAdminAuth);

router.get('/viral-videos/settings', getViralVideosSettings);
router.put('/viral-videos/settings', updateViralVideosSettings);
router.get('/viral-videos', listAdminViralVideos);
router.post('/viral-videos', createAdminViralVideo);
router.post('/viral-videos/upload', uploadViralVideoMediaFile);
router.post('/viral-videos/upload/video', uploadViralVideoFile);
router.post('/viral-videos/video-upload', uploadViralVideoFile);
router.post('/viral-videos/upload-thumbnail', coverUpload.any(), uploadViralVideoThumbnailFile);
router.post('/viral-videos/thumbnail-upload', coverUpload.any(), uploadViralVideoThumbnailFile);
router.post('/viral-videos/thumbnail', coverUpload.any(), uploadViralVideoThumbnailFile);
router.post('/viral-videos/upload/image', coverUpload.any(), uploadViralVideoThumbnailFile);
router.post('/viral-videos/upload-video', uploadViralVideoFile);
router.get('/viral-videos/:id/preview', previewAdminViralVideo);
router.post('/viral-videos/:id/publish', publishAdminViralVideo);
router.patch('/viral-videos/:id/publish', publishAdminViralVideo);
router.post('/viral-videos/:id/unpublish', unpublishAdminViralVideo);
router.patch('/viral-videos/:id/unpublish', unpublishAdminViralVideo);
router.patch('/viral-videos/:id/status', updateAdminViralVideoStatus);
router.post('/viral-videos/:id/status', updateAdminViralVideoStatus);
router.get('/viral-videos/:id', getAdminViralVideoById);
router.put('/viral-videos/:id', updateAdminViralVideo);
router.patch('/viral-videos/:id', updateAdminViralVideo);
router.delete('/viral-videos/:id', deleteAdminViralVideo);
router.all('/viral-videos/*', (req, res) => {
	return res.status(404).json({
		ok: false,
		message: 'Viral Videos admin route not found',
		path: req.originalUrl,
		method: req.method,
	});
});

module.exports = router;
