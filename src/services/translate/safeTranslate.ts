// SafeTranslate wrapper (server-side only).
//
// The production runtime is CommonJS; the canonical runtime implementation lives in:
//   services/translate/safeTranslate.js
// This file provides a typed interface for code/docs that import from src/*.

export type Lang = 'en' | 'hi' | 'gu';

export type SafeTranslateInput = {
  text: string;
  sourceLang: Lang;
  targetLang: Lang;
  context?: string;
  strict?: boolean;
};

export type SafeTranslateResult = {
  text: string;
  usedFallback: boolean;
  score: number;
  warnings: string[];
  provider: 'GOOGLE' | null;
  fromCache: boolean;
};

// Typed wrapper around the runtime implementation.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtime = require('../../../services/translate/safeTranslate');

export async function safeTranslateText(input: SafeTranslateInput): Promise<SafeTranslateResult> {
  return runtime.safeTranslateText(input);
}
