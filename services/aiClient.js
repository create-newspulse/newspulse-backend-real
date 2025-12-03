const openai = require('../lib/openai');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

/**
 * Ask KiranOS a question.
 * @param {{ question: string; language?: 'en'|'hi'|'gu'; articleText?: string }} options
 * @returns {Promise<{ answer: string; bullets: string[]; language: 'en'|'hi'|'gu' }>}
 */
async function askKiranOS(options) {
  const question = String(options?.question || '').trim();
  const language = (options?.language || 'en');
  const articleText = String(options?.articleText || '').trim();
  if (question.length < 3) {
    const err = new Error('Question too short');
    err.code = 'QUESTION_TOO_SHORT';
    throw err;
  }
  const langHint = language === 'hi' ? 'Answer in Hindi.' : language === 'gu' ? 'Answer in Gujarati.' : 'Answer in English.';
  const safetyRules = [
    'Keep the answer clear and short.',
    'Provide 2–4 concise bullet key points.',
    'Avoid hate, harassment, politics advising, or personal attacks.',
  ].join(' ');
  const articleGuard = articleText
    ? 'Use ONLY the provided article text as the factual base. If a detail is not in this text, say you don’t know.'
    : 'If unsure about facts, be honest and say you don’t know.';

  const systemPrompt = [langHint, safetyRules, articleGuard].join(' ');
  const userPrompt = articleText
    ? `Question: ${question}\n\nArticle Text:\n${articleText}`
    : `Question: ${question}`;

  // If OpenAI client not configured, return a safe stub
  if (!openai) {
    return {
      answer: 'KiranOS demo mode: AI is not configured. Here is a safe placeholder answer to your question.',
      bullets: [
        'Bullet 1: This is a demo response.',
        'Bullet 2: Configure OPENAI_API_KEY on the server to enable AI.',
      ],
      language,
    };
  }

  try {
    const completion = await openai.responses.create({
      model: DEFAULT_MODEL,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    // Extract text; support both content and output_text shapes
    const raw = (completion?.output_text) || '';
    const text = raw || (Array.isArray(completion?.content) ? (completion.content[0]?.text || '') : '');

    // Simple parsing: split bullets if present using lines starting with - or *
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const bullets = lines.filter(l => l.match(/^[-*]\s+/)).map(l => l.replace(/^[-*]\s+/, ''));
    const answer = lines.filter(l => !l.match(/^[-*]\s+/)).join(' ');

    return { answer: answer || text || 'No answer generated.', bullets: bullets.slice(0, 4), language };
  } catch (e) {
    const err = new Error('AI request failed');
    err.code = 'AI_REQUEST_FAILED';
    err.cause = e;
    throw err;
  }
}

module.exports = { askKiranOS };
