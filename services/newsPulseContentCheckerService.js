const { z } = require('zod');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];
const MAX_TITLE_LENGTH = 250;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 20000;
const MAX_SOURCES = 10;
const MAX_EVIDENCE_SNIPPETS = 3;
const MAX_EVIDENCE_CHARS = 220;

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','for','with','without','from','into','onto','over','under','after','before','during','while','because','about','against','between','through','across','within','without','their','there','these','those','this','that','was','were','is','are','be','been','being','of','to','in','on','at','by','as','it','its','he','she','they','them','we','you','i','his','her','who','what','when','where','why','how','more','most','some','many','all','any','each','every','into','out','up','down','off','not','no','yes','do','does','did','can','could','should','would','may','might','must','have','has','had','again','same','new','old','just',
  'के','का','की','कि','ये','यह','उस','उसने','उन','उनके','उनका','है','हैं','था','थी','थे','से','में','पर','को','कर','किया','किए','लिए','या','और','लेकिन','अगर','जब','जहां','क्यों','कैसे','कई','सब','कुछ','अभी','आज','कल','रात','दिन','दो','तीन','चार','सभी','नहीं','हुआ','हुई','जैसे','तथा',
  'હું','હવે','તે','આ','આપણે','પર','માટે','કેવી','કઈ','સૌથી','જે','જ્યાં','કારણ','કેમ','કેવી રીતે','આર','$'
]);

const ATTRIBUTION_PATTERNS = [
  /according to/i,
  /police said/i,
  /officials said/i,
  /ministry said/i,
  /statement/i,
  /report/i,
  /court/i,
  /agency/i,
  /source/i,
  /data from/i,
  /as per/i,
  /quoted by/i,
  /\bsaid\b/i,
  /पुलिस ने/i,
  /अधिकारियों ने/i,
  /मंत्रालय ने/i,
  /बयान/i,
  /रिपोर्ट/i,
  /स्रोत/i,
  /डेटा से/i,
  /પોલિસે/i,
  /સત્તાવાળાઓએ/i,
  /મંત્રાલયે/i,
  /બयान/i,
  /અહેવાલ/i,
  /સ્રોત/i,
  /ડેટા લૂછી/i,
  /તાવડામાં/i,
];

const NUMBER_PATTERNS = [
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/,
  /\b\d+(?:\.\d+)?\s*(?:%|percent|per cent)\b/i,
  /\b(?:₹|Rs|INR|USD|EUR)\s*\d+(?:,\d{3})*(?:\.\d+)?\b/i,
  /\b\d+(?:\.\d+)?\s*(?:lakh|lacs|lakhs|crore|crores|million|billion)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:लाख|करोड़|मिलियन|अरब|हज़ार)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:લાખ|કરોડ|મિલિયન|હજાર)\b/i,
  /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december))\b/i,
  /\b(?:on|by|in)\s+\d{1,2}(?:\/|-)\d{1,2}(?:\/|-)\d{2,4}\b/i,
];

const SENSATIONAL_PATTERNS = [
  /shocking|shock|unbelievable|guaranteed|miracle|absolutely proves|explosive|dramatic|sensational/i,
  /चौंकाने|अविश्वसनीय|गारंटी|अलौकिक|पूरी तरह साबित|बिल्कुल सिद्ध|भयानक/i,
  /આશ્ચર્યજનક|આશ્ચર્ય|ગેરફોર્મ|ચોકાવનારી|ગેરંટી|મહાન|સૌથી મોટું/i,
];

const FIVE_W_ONE_H_PATTERNS = {
  who: [/\bwho\b/i, /\bwhoever\b/i, /\bकौन\b/i, /\bકોન\b/i],
  what: [/\bwhat\b/i, /\bक्या\b/i, /\bશું\b/i],
  when: [/\bwhen\b/i, /\bकब\b/i, /\bક્યારે\b/i],
  where: [/\bwhere\b/i, /\bकहाँ\b/i, /\bજ્યાં\b/i],
  why: [/\bwhy\b/i, /\bक्यों\b/i, /\bકારણ\b/i],
  how: [/\bhow\b/i, /\bकैसे\b/i, /\bકેમ\b/i],
};

function normalizeLanguage(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'en';
  const lower = raw.toLowerCase();
  const first = lower.split(/[-_]/)[0];
  if (SUPPORTED_LANGS.includes(first)) return first;
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj' || lettersOnly === 'gj') return 'gu';
  return 'en';
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  const raw = stripHtml(value ?? '');
  return raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toSentenceList(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenise(text, language = 'en') {
  const source = String(text || '').toLowerCase();
  if (!source.trim()) return [];
  const normalized = source
    .replace(/[\u2018\u2019\u201C\u201D"“”'‘’]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.split(/\s+/).filter((token) => token && !STOPWORDS.has(token) && token.length > 1);
}

function summaryCounts(checks) {
  const summary = { passed: 0, review: 0, highRisk: 0 };
  for (const check of checks) {
    const status = check.status;
    if (status === 'pass') summary.passed += 1;
    else if (status === 'review') summary.review += 1;
    else if (status === 'high-risk') summary.highRisk += 1;
  }
  return summary;
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/(mongodb(?:\+srv)?:\/\/[^\s]+)/gi, '[redacted]')
    .replace(/(jwt\s*[:=]\s*[A-Za-z0-9._-]+)/gi, '[redacted]')
    .replace(/(ANALYTICS_HASH_SALT\s*[:=]\s*[^\s]+)/gi, '[redacted]')
    .replace(/(Bearer\s+[A-Za-z0-9-._~+/]+=*)/gi, '[redacted]')
    .replace(/(authorization\s*[:=]\s*[A-Za-z0-9-._~+/]+=*)/gi, '[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*[A-Za-z0-9._-]+)/gi, '[redacted]');
}

function excerpt(snippet, limit = MAX_EVIDENCE_CHARS) {
  const cleaned = redactSecrets(cleanText(snippet || '')).replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trim()}…` : cleaned;
}

function makeCheck({ id, label, status, message, recommendation = '', evidence = [] }) {
  return {
    id,
    label,
    status,
    message,
    recommendation,
    evidence: evidence.slice(0, MAX_EVIDENCE_SNIPPETS).map((entry) => ({
      excerpt: excerpt(entry && entry.excerpt ? entry.excerpt : entry),
    })).filter((entry) => entry.excerpt),
  };
}

function hasAttributionSignal(text) {
  return ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function hasSourceContext(sources) {
  if (!Array.isArray(sources)) return false;
  const joined = sources.map((s) => String(s || '')).join(' ');
  return !!joined.trim() && /(?:source|statement|report|official|agency|police|ministry|court|data)/i.test(joined);
}

function detectMissingFiveWOneH(text) {
  const source = String(text || '');
  const found = [];
  for (const [key, patterns] of Object.entries(FIVE_W_ONE_H_PATTERNS)) {
    if (patterns.some((rx) => rx.test(source))) found.push(key);
  }
  const missing = ['who', 'what', 'when', 'where', 'why', 'how'].filter((key) => !found.includes(key));
  return missing;
}

function validateContentPayload(rawBody) {
  const schema = z.object({
    title: z.union([z.string(), z.null(), z.undefined()]).optional().transform((value) => (value == null ? '' : String(value))),
    summary: z.union([z.string(), z.null(), z.undefined()]).optional().transform((value) => (value == null ? '' : String(value))),
    content: z.union([z.string(), z.null(), z.undefined()]).optional().transform((value) => (value == null ? '' : String(value))),
    language: z.union([z.string(), z.null(), z.undefined()]).optional().transform((value) => (value == null ? 'en' : String(value))),
    sources: z.union([z.array(z.string()), z.null(), z.undefined()]).optional().transform((value) => Array.isArray(value) ? value : []),
  }).strict();

  const parsed = schema.safeParse(rawBody || {});
  if (!parsed.success) {
    const firstIssue = parsed.error.issues?.[0]?.message || 'Invalid payload';
    return { ok: false, message: firstIssue, code: 'INVALID_PAYLOAD' };
  }

  const data = parsed.data;
  const title = cleanText(data.title || '');
  const summary = cleanText(data.summary || '');
  const content = cleanText(data.content || '');
  const language = normalizeLanguage(data.language || 'en');
  const sources = Array.isArray(data.sources) ? data.sources.slice(0, MAX_SOURCES).map((value) => cleanText(value)).filter(Boolean) : [];

  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: 'title exceeds maximum length', code: 'TITLE_TOO_LONG' };
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, message: 'summary exceeds maximum length', code: 'SUMMARY_TOO_LONG' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { ok: false, message: 'content exceeds maximum length', code: 'CONTENT_TOO_LONG' };
  }
  if (!SUPPORTED_LANGS.includes(language)) {
    return { ok: false, message: 'Unsupported language', code: 'UNSUPPORTED_LANGUAGE' };
  }
  if (sources.length > MAX_SOURCES) {
    return { ok: false, message: 'sources exceeds maximum length', code: 'SOURCES_TOO_LONG' };
  }

  const totalText = [title, summary, content].join(' ').trim();
  if (!totalText || ![title, summary, content].some((part) => String(part || '').trim().length > 0)) {
    return { ok: false, message: 'Provide meaningful title, summary, or article content before running the checker', code: 'EMPTY_CONTENT' };
  }

  if (String(title || '').trim().length < 1 && String(summary || '').trim().length < 1 && String(content || '').trim().length < 30) {
    return { ok: false, message: 'Provide meaningful title, summary, or article content before running the checker', code: 'EMPTY_CONTENT' };
  }

  return { ok: true, data: { title, summary, content, language, sources } };
}

function buildHeadlineBodyMismatchCheck(title, content) {
  const titleTokens = tokenise(title, 'en');
  const bodyTokens = tokenise(content, 'en');
  if (!titleTokens.length || !bodyTokens.length) return null;
  const overlap = titleTokens.filter((token) => bodyTokens.includes(token));
  const overlapRatio = overlap.length / Math.max(titleTokens.length, 1);
  if (overlapRatio >= 0.35) return null;
  return makeCheck({
    id: 'headline-body-match',
    label: 'Headline / Body Match',
    status: 'review',
    message: 'Headline and body appear weakly connected; a human review is recommended.',
    recommendation: 'Confirm the headline reflects the article content before publication.',
    evidence: [{ excerpt: title }, { excerpt: content }],
  });
}

function buildRepetitionCheck(text) {
  const sentences = toSentenceList(text);
  if (sentences.length < 2) return null;
  const counts = new Map();
  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const repeated = [...counts.entries()].filter(([_, count]) => count > 1);
  if (!repeated.length) return null;
  const excerptText = repeated[0][0];
  return makeCheck({
    id: 'repetition',
    label: 'Repetition',
    status: 'review',
    message: 'Repeated sentence or phrasing was detected in the article body.',
    recommendation: 'Trim repeated wording and verify the text is not duplicated.',
    evidence: [{ excerpt: excerptText.slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function buildSensationalLanguageCheck(text) {
  const match = SENSATIONAL_PATTERNS.find((pattern) => pattern.test(text));
  if (!match) return null;
  const matchedString = String(text.match(match) || '');
  return makeCheck({
    id: 'sensational-language',
    label: 'Sensational / Loaded Language',
    status: 'review',
    message: 'The article contains strongly promotional or loaded wording that should be reviewed by an editor.',
    recommendation: 'Tone down loaded wording and keep the language neutral and factual.',
    evidence: [{ excerpt: matchedString || text.slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function buildFiveWOneHCheck(title, summary, content) {
  const source = `${title} ${summary} ${content}`;
  const missing = detectMissingFiveWOneH(source);
  if (!missing.length) {
    return makeCheck({
      id: 'five-w-one-h',
      label: '5W1H Editorial Context',
      status: 'pass',
      message: 'The article includes a basic set of editorial context signals.',
      recommendation: '',
      evidence: [],
    });
  }
  return makeCheck({
    id: 'five-w-one-h',
    label: '5W1H Editorial Context',
    status: 'review',
    message: `Possible missing context: ${missing.map((key) => key.toUpperCase()).join(', ')}`,
    recommendation: 'Add the missing context before publication to improve clarity and attribution.',
    evidence: [{ excerpt: source.slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function buildQuoteVerificationCheck(text) {
  const quotePattern = /["““][^"“”]+["”]|?['‘][^'’]+['’]/g;
  const matches = text.match(quotePattern) || [];
  if (!matches.length) return null;
  const aroundQuote = String(text).slice(0, 220);
  if (hasAttributionSignal(text)) {
    return null;
  }
  return makeCheck({
    id: 'quotes-verification',
    label: 'Quote Verification',
    status: 'review',
    message: 'Quotation requires source verification.',
    recommendation: 'Attach a clear attribution or source context before publishing the quoted material.',
    evidence: [{ excerpt: aroundQuote }],
  });
}

function buildNumbersCheck(text, sourceList) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/);
  const candidateSentences = sentences.filter((sentence) => {
    if (/\d/.test(sentence)) return true;
    return NUMBER_PATTERNS.some((pattern) => pattern.test(sentence));
  });
  if (!candidateSentences.length) return null;

  const hasExternalSource = hasSourceContext(sourceList);
  for (const sentence of candidateSentences) {
    const localAttribution = hasAttributionSignal(sentence);
    if (localAttribution || hasExternalSource) {
      continue;
    }

    return makeCheck({
      id: 'numbers-verification',
      label: 'Numbers / Statistics',
      status: 'review',
      message: 'A significant numerical claim appears without a clear attribution or source context.',
      recommendation: 'Add the source, date, or attribution for the figures before publication.',
      evidence: [{ excerpt: sentence.slice(0, MAX_EVIDENCE_CHARS) }],
    });
  }

  return makeCheck({
    id: 'numbers-verification',
    label: 'Numbers / Statistics',
    status: 'pass',
    message: 'The article includes numerical claims with adequate attribution or source context.',
    recommendation: '',
    evidence: [{ excerpt: candidateSentences[0].slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function buildSourceAttributionCheck(title, summary, content, sources) {
  const fullText = `${title} ${summary} ${content}`;
  const hasSignal = hasAttributionSignal(fullText) || hasSourceContext(sources);
  const hasSubstantiveContent = /\b(?:people|officials|market|police|minister|court|agency|report|study|survey|data|election|government|hospital|school|accident|fire|storm|result|injured|killed|died|arrested|reopened|closed)\b/i.test(fullText);
  if (!hasSubstantiveContent) return null;
  if (hasSignal) {
    return makeCheck({
      id: 'source-attribution',
      label: 'Source Attribution',
      status: 'pass',
      message: 'Attribution or source context is present in the draft.',
      recommendation: '',
      evidence: [],
    });
  }
  return makeCheck({
    id: 'source-attribution',
    label: 'Source Attribution',
    status: 'review',
    message: 'Factual reporting appears to be missing attribution or source context.',
    recommendation: 'Add the relevant source, statement, or attribution before publishing.',
    evidence: [{ excerpt: content.slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function buildCompletenessCheck(title, summary, content) {
  const issues = [];
  if (!title || title.length < 6) issues.push('headline/title');
  if (!summary || summary.trim().length < 10) issues.push('summary');
  if (!content || content.trim().length < 30) issues.push('body/content');
  if (!issues.length) {
    return makeCheck({
      id: 'article-completeness',
      label: 'Article Completeness',
      status: 'pass',
      message: 'The draft contains a meaningful headline, summary, and article body.',
      recommendation: '',
      evidence: [],
    });
  }
  return makeCheck({
    id: 'article-completeness',
    label: 'Article Completeness',
    status: 'high-risk',
    message: `Clearly incomplete material detected: ${issues.join(', ')}.`,
    recommendation: 'Add the missing headline, summary, or article text before publication.',
    evidence: [{ excerpt: `${title || 'missing title'} ${summary || 'missing summary'} ${content || 'missing body'}`.slice(0, MAX_EVIDENCE_CHARS) }],
  });
}

function analyzeNewsPulseContent(rawBody) {
  const validated = validateContentPayload(rawBody);
  if (!validated.ok) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      overallStatus: 'review',
      summary: { passed: 0, review: 0, highRisk: 0 },
      checks: [],
      error: validated.message,
      code: validated.code,
    };
  }

  const { title, summary, content, language, sources } = validated.data;
  const checks = [];

  const completenessCheck = buildCompletenessCheck(title, summary, content);
  checks.push(completenessCheck);

  const sourceAttributionCheck = buildSourceAttributionCheck(title, summary, content, sources);
  if (sourceAttributionCheck) checks.push(sourceAttributionCheck);

  const quoteVerification = buildQuoteVerificationCheck(content);
  if (quoteVerification) checks.push(quoteVerification);

  const numbersCheck = buildNumbersCheck(content, sources);
  if (numbersCheck) checks.push(numbersCheck);

  const headlineBodyMatch = buildHeadlineBodyMismatchCheck(title, content);
  if (headlineBodyMatch) checks.push(headlineBodyMatch);

  const repetitionCheck = buildRepetitionCheck(content);
  if (repetitionCheck) checks.push(repetitionCheck);

  const sensationalLanguageCheck = buildSensationalLanguageCheck(content);
  if (sensationalLanguageCheck) checks.push(sensationalLanguageCheck);

  const fiveWCheck = buildFiveWOneHCheck(title, summary, content);
  checks.push(fiveWCheck);

  const internalDuplicateCheck = repetitionCheck || headlineBodyMatch || null;
  if (internalDuplicateCheck && internalDuplicateCheck.id === 'repetition') {
    checks.push(makeCheck({
      id: 'internal-duplication',
      label: 'Possible duplicate content indicator',
      status: 'review',
      message: 'Possible duplicate content indicator detected within the submitted draft.',
      recommendation: 'Verify whether the repeated text is intentional before publication.',
      evidence: internalDuplicateCheck.evidence,
    }));
  }

  const normalizedLanguage = normalizeLanguage(language);
  if (!SUPPORTED_LANGS.includes(normalizedLanguage)) {
    checks.push(makeCheck({
      id: 'language-support',
      label: 'Language Support',
      status: 'review',
      message: 'Language could not be confidently validated for the current draft.',
      recommendation: 'Use one of the supported language codes: en, hi, gu.',
      evidence: [],
    }));
  }

  const summaryReport = summaryCounts(checks);
  let overallStatus = 'clear';
  if (checks.some((check) => check.status === 'high-risk')) overallStatus = 'high-risk';
  else if (checks.some((check) => check.status === 'review')) overallStatus = 'review';

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    overallStatus,
    summary: summaryReport,
    checks,
    language: normalizedLanguage,
  };
}

module.exports = {
  analyzeNewsPulseContent,
  normalizeLanguage,
  SUPPORTED_LANGS,
};
