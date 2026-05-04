const express = require('express');
const jwt = require('jsonwebtoken');

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

function parseCookies(header) {
	const cookies = {};
	String(header || '').split(';').forEach((part) => {
		const [key, ...valueParts] = part.trim().split('=');
		if (!key) return;
		cookies[key] = decodeURIComponent(valueParts.join('=') || '');
	});
	return cookies;
}

function isViralVideoUploadPath(req) {
	return /\/viral-videos\/(upload-video|upload\/video|video-upload)(?:[/?]|$)/.test(String(req.originalUrl || req.path || ''));
}

function getAdminToken(req) {
	const authHeader = String(req.headers.authorization || '');
	if (authHeader.toLowerCase().startsWith('bearer ')) return authHeader.slice('Bearer '.length).trim();
	const cookies = parseCookies(req.headers.cookie || '');
	return String(cookies.np_admin_token || '').trim();
}

function logViralVideosUploadAuth(req, authValid, reason = null) {
	try {
		// eslint-disable-next-line no-console
		console.error('[viral-videos][cloudinary-video-upload][auth-check]', {
			route: req.originalUrl || req.path,
			authValid,
			...(reason ? { reason } : {}),
		});
	} catch (_) {}
}

function requireViralVideosAdminAuth(req, res, next) {
	if (isViralVideoUploadPath(req)) {
		const token = getAdminToken(req);
		if (token && !token.startsWith('np.')) {
			const decoded = jwt.decode(token);
			if (decoded && typeof decoded.exp === 'number' && decoded.exp <= Math.floor(Date.now() / 1000)) {
				logViralVideosUploadAuth(req, false, 'expired');
				return res.status(401).json({ ok: false, code: 'ADMIN_AUTH_EXPIRED', message: 'Admin session expired. Please login again.' });
			}
		}
		return requireAdminAuth(req, res, (err) => {
			if (err) return next(err);
			logViralVideosUploadAuth(req, true);
			return next();
		});
	}
	return requireAdminAuth(req, res, next);
}

router.use('/viral-videos', requireViralVideosAdminAuth);

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
