// Google-only translation helper used by the backend.
// Note: the production runtime is CommonJS (server.js). The runtime implementation
// lives in services/translate/googleTranslate.js; this file exists for typed imports.

export async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const q = String(text || '').trim();
  const source = String(sourceLang || '').trim().toLowerCase();
  const target = String(targetLang || '').trim().toLowerCase();

  if (!apiKey) return null;
  if (!q) return null;
  if (!source || !target) return null;
  if (source === target) return q;
  if (typeof fetch !== 'function') return null;

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
    return typeof translated === 'string' ? translated : null;
  } catch {
    return null;
  }
}
