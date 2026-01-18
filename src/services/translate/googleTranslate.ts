// Google-only translation helper used by the backend.
// Note: the production runtime is CommonJS (server.js). The runtime implementation
// lives in services/translate/googleTranslate.js; this file exists for typed imports.

function normalizeLang(v: string): 'en' | 'hi' | 'gu' | null {
  const s = String(v || '').trim().toLowerCase();
  return (s === 'en' || s === 'hi' || s === 'gu') ? (s as any) : null;
}

function decodeBasicEntities(s: string): string {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function protectByRegex(text: string, regex: RegExp, prefix: string) {
  const map = new Map<string, string>();
  let i = 0;
  const out = String(text || '').replace(regex, (m) => {
    const token = `__${prefix}_${i}__`;
    i++;
    map.set(token, m);
    return token;
  });
  return { text: out, map };
}

function restore(text: string, map: Map<string, string>) {
  let out = String(text || '');
  for (const [token, value] of map.entries()) {
    out = out.split(token).join(value);
  }
  return out;
}

export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const raw = String(text || '').trim();
  const source = normalizeLang(sourceLang);
  const target = normalizeLang(targetLang);

  if (!apiKey) return null;
  if (!raw) return null;
  if (!source || !target) return null;
  if (source === target) return raw;
  if (typeof fetch !== 'function') return null;

  // Never translate URLs/emails; keep numbers/currency/percentages/dates stable.
  const urlRx = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
  const emailRx = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const numericRx = /(?:₹|\$|€|£)?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?%\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g;

  const { text: t0, map: urlMap } = protectByRegex(raw, urlRx, 'URL');
  const { text: t1, map: emailMap } = protectByRegex(t0, emailRx, 'EMAIL');
  const { text: q, map: numMap } = protectByRegex(t1, numericRx, 'NUM');

  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: [q], source, target, format: 'text' }),
    });

    if (!res.ok) return null;

    const data: any = await res.json().catch(() => null);
    const translated = data?.data?.translations?.[0]?.translatedText;
    if (typeof translated !== 'string') return null;
    const cleaned = decodeBasicEntities(translated).trim();
    if (!cleaned) return null;
    const restored = restore(restore(restore(cleaned, numMap), emailMap), urlMap).trim();
    return restored || null;
  } catch {
    return null;
  }
}
