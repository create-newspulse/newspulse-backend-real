const mongoose = require('mongoose');

const PushRegistration = require('../models/PushRegistration');
const {
  getFirebaseAdminStatus,
  getFirebaseMessagingClient,
} = require('../lib/firebaseAdmin');

const NEWS_PULSE_HOSTS = new Set(['newspulse.co.in', 'www.newspulse.co.in']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const NOTIFICATION_TYPES = new Set(['test', 'breaking_news', 'top_story', 'article', 'category']);

function trim(value) {
  return String(value || '').trim();
}

function maskRegistrationId(value) {
  const raw = trim(value);
  if (!raw) return '';
  if (raw.length <= 12) return `${raw.slice(0, 3)}...${raw.slice(-3)}`;
  return `${raw.slice(0, 6)}...${raw.slice(-6)}`;
}

function isLocalLike() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  return env !== 'production' && !process.env.RENDER && !process.env.RENDER_SERVICE_ID;
}

function getFrontendBaseUrl() {
  const raw = trim(
    process.env.PUBLIC_FRONTEND_URL
    || process.env.PUBLIC_WEBSITE_URL
    || process.env.NEWS_PULSE_PUBLIC_SITE_URL
    || process.env.SITE_URL
    || process.env.APP_BASE_URL
    || 'https://www.newspulse.co.in'
  );
  return raw.replace(/\/+$/, '');
}

function isApprovedPushUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (NEWS_PULSE_HOSTS.has(host)) return parsed.protocol === 'https:';
    if (isLocalLike() && LOCAL_HOSTS.has(host)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function normalizePushUrl(value, { articleSlug } = {}) {
  const raw = trim(value);
  const base = getFrontendBaseUrl();
  let candidate = raw;

  if (!candidate && articleSlug) {
    candidate = `/news/${encodeURIComponent(trim(articleSlug))}`;
  }
  if (!candidate) candidate = base || 'https://www.newspulse.co.in';

  try {
    const absolute = candidate.startsWith('/') ? new URL(candidate, base || 'https://www.newspulse.co.in').toString() : new URL(candidate).toString();
    if (!isApprovedPushUrl(absolute)) return null;
    return absolute;
  } catch (_) {
    return null;
  }
}

function firebaseErrorCode(error) {
  return trim(error?.code || error?.errorInfo?.code || error?.errorCode || 'firebase/send-failed');
}

function isPermanentRegistrationError(error) {
  const code = firebaseErrorCode(error).toLowerCase();
  return code === 'messaging/registration-token-not-registered'
    || code === 'messaging/invalid-registration-token';
}

function sanitizeFailureReason(error, registration) {
  let message = trim(error?.message || error);
  const registrationId = trim(registration?.registrationId);
  if (registrationId) message = message.split(registrationId).join('[redacted-registration-id]');
  message = message.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-private-key]');
  message = message.replace(/("private_key"\s*:\s*")[^"]+(")/gi, '$1[redacted-private-key]$2');
  return message.slice(0, 240) || 'Firebase send failed';
}

function buildMessagePayload(registration, message) {
  const title = trim(message.title).slice(0, 120) || 'News Pulse';
  const body = trim(message.body).slice(0, 240) || 'Firebase push notifications are working.';
  const notificationType = trim(message.notificationType || 'test').toLowerCase();
  const type = NOTIFICATION_TYPES.has(notificationType) ? notificationType : 'article';
  const url = normalizePushUrl(message.url, { articleSlug: message.articleSlug });
  if (!url) {
    const error = new Error('Notification URL is not allowed');
    error.code = 'push/invalid-url';
    throw error;
  }

  const data = {
    notificationType: type,
    url,
  };
  for (const key of ['articleId', 'articleSlug', 'category', 'language']) {
    const value = trim(message[key]);
    if (value) data[key] = value.slice(0, 200);
  }

  const payload = {
    token: registration.registrationId,
    notification: { title, body },
    data,
    webpush: {
      fcmOptions: { link: url },
      notification: {
        title,
        body,
      },
    },
  };

  const image = trim(message.image);
  if (image && isApprovedPushUrl(image)) {
    payload.webpush.notification.image = image;
  }

  return payload;
}

async function updateRegistrationHealth(registration, update) {
  if (!registration?._id) return;
  try {
    await PushRegistration.updateOne({ _id: registration._id }, update);
  } catch (error) {
    console.warn('[push][registration-health-update-failed]', {
      id: maskRegistrationId(registration.registrationId),
      message: error?.message || String(error),
    });
  }
}

async function sendPushToRegistration(registration, message) {
  if (!registration || !registration.registrationId) {
    return { success: false, sent: false, reason: 'registration_not_found' };
  }

  if (registration.enabled === false || registration.status === 'inactive') {
    return { success: false, sent: false, reason: 'registration_disabled' };
  }

  if (registration.registrationType !== 'token') {
    return { success: false, sent: false, reason: 'unsupported_registration_type', registrationType: registration.registrationType };
  }

  const status = getFirebaseAdminStatus();
  if (!status.configured || !status.messagingAvailable) {
    return { success: false, sent: false, reason: status.status === 'initialization_error' ? 'firebase_initialization_error' : 'firebase_not_configured' };
  }

  const messaging = getFirebaseMessagingClient();
  if (!messaging) {
    return { success: false, sent: false, reason: 'firebase_messaging_unavailable' };
  }

  let payload;
  try {
    payload = buildMessagePayload(registration, message);
  } catch (error) {
    return { success: false, sent: false, reason: error.code || 'invalid_message' };
  }

  try {
    const messageId = await messaging.send(payload, false);
    await updateRegistrationHealth(registration, {
      $set: {
        lastSuccessfulSendAt: new Date(),
        lastFailureAt: null,
        lastFailureCode: null,
        lastFailureReason: null,
        status: 'active',
      },
    });
    return { success: true, sent: true, messageId };
  } catch (error) {
    const permanent = isPermanentRegistrationError(error);
    const failureCode = firebaseErrorCode(error);
    const failureMessage = sanitizeFailureReason(error, registration);
    const update = {
      $set: {
        lastFailureAt: new Date(),
        lastFailureCode: failureCode,
        lastFailureReason: failureMessage,
      },
    };
    if (permanent) {
      update.$set.enabled = false;
      update.$set.status = 'inactive';
      update.$set.disabledAt = new Date();
    }
    await updateRegistrationHealth(registration, update);
    return {
      success: false,
      sent: false,
      reason: permanent ? 'registration_invalid' : 'firebase_send_failed',
      permanent,
      code: failureCode,
      message: failureMessage,
    };
  }
}

function queryWithRegistrationId(query) {
  if (query && typeof query.select === 'function') return query.select('+registrationId');
  return query;
}

async function resolveTestRegistration({ registrationId, registrationType } = {}) {
  const id = trim(registrationId);
  if (id) {
    let query = PushRegistration.findOne({
      registrationId: id,
      registrationType: registrationType === 'fid' ? 'fid' : 'token',
    });
    query = queryWithRegistrationId(query);
    if (query && typeof query.lean === 'function') return query.lean();
    return query;
  }

  let query = PushRegistration.findOne({ enabled: true, status: 'active', registrationType: 'token' });
  if (query && typeof query.sort === 'function') query = query.sort({ lastRegisteredAt: -1, updatedAt: -1 });
  query = queryWithRegistrationId(query);
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

async function sendTestPushNotification(input = {}) {
  const registration = await resolveTestRegistration(input);
  if (!registration) return { success: false, sent: false, reason: 'registration_not_found' };

  return sendPushToRegistration(registration, {
    title: input.title || 'News Pulse',
    body: input.body || 'Firebase push notifications are working.',
    url: input.url || (isLocalLike() ? 'http://localhost:3000' : getFrontendBaseUrl()),
    notificationType: 'test',
  });
}

function buildEligibilityFilter(kind, options = {}) {
  const filter = { enabled: true, status: 'active', registrationType: 'token' };
  if (options.language) filter.language = options.language;
  if (kind === 'breaking_news') filter['preferences.breakingNews'] = true;
  if (kind === 'top_story') filter['preferences.topStories'] = true;
  if (kind === 'article') filter['preferences.newArticleAlerts'] = true;
  if (kind === 'category') {
    filter['preferences.categoryAlerts'] = true;
    if (options.category) filter.categories = options.category;
  }
  if (kind === 'all_articles') filter['preferences.allArticles'] = true;
  return filter;
}

function sendBreakingNews(message, options = {}) {
  return { filter: buildEligibilityFilter('breaking_news', options), message };
}

function sendTopStory(message, options = {}) {
  return { filter: buildEligibilityFilter('top_story', options), message };
}

function sendArticleNotification(message, options = {}) {
  return { filter: buildEligibilityFilter('article', options), message };
}

function sendCategoryNotification(message, options = {}) {
  return { filter: buildEligibilityFilter('category', options), message };
}

function isMongoReadyForPush() {
  return mongoose.connection.readyState === 1 || String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

module.exports = {
  getFrontendBaseUrl,
  normalizePushUrl,
  isApprovedPushUrl,
  maskRegistrationId,
  buildMessagePayload,
  isPermanentRegistrationError,
  sendPushToRegistration,
  sendTestPushNotification,
  buildEligibilityFilter,
  sendBreakingNews,
  sendTopStory,
  sendArticleNotification,
  sendCategoryNotification,
  isMongoReadyForPush,
};