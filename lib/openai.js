const OpenAI = require('openai');

// Initialize OpenAI client. API key must be set in environment as OPENAI_API_KEY.
// No key -> functions relying on this should gracefully fallback.
// Safety: never call external AI during tests.
const _env = String(process.env.NODE_ENV || 'development').toLowerCase();
const _disable = _env === 'test' || String(process.env.DISABLE_OPENAI || '').trim() === '1';
const apiKey = process.env.OPENAI_API_KEY || '';
let openai = null;
if (_disable) {
  if (_env === 'test') {
    console.warn('[OpenAI][disabled] NODE_ENV=test; AI calls are disabled');
  } else {
    console.warn('[OpenAI][disabled] DISABLE_OPENAI=1 set; AI calls are disabled');
  }
} else if (apiKey) {
  try {
    openai = new OpenAI({ apiKey });
  } catch (e) {
    console.error('[OpenAI][init-error]', e?.message || e);
  }
} else {
  console.warn('[OpenAI][init] OPENAI_API_KEY not set; AI policy checks will fallback.');
}

module.exports = openai;