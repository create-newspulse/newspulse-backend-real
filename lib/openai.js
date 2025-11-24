const OpenAI = require('openai');

// Initialize OpenAI client. API key must be set in environment as OPENAI_API_KEY.
// No key -> functions relying on this should gracefully fallback.
const apiKey = process.env.OPENAI_API_KEY || '';
let openai = null;
if (apiKey) {
  try {
    openai = new OpenAI({ apiKey });
  } catch (e) {
    console.error('[OpenAI][init-error]', e?.message || e);
  }
} else {
  console.warn('[OpenAI][init] OPENAI_API_KEY not set; AI policy checks will fallback.');
}

module.exports = openai;