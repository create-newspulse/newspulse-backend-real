// Phase 1: TS-friendly entrypoint.
// The backend runtime is CommonJS (server.js), so the real implementation lives in services/translationGuard.js.
// This file exists to satisfy the Phase 1 deliverable path and to enable future TS adoption.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const impl = require('../../services/translationGuard');

export const preprocess = impl.preprocess as (text: string) => { text: string; locks: Array<{ placeholder: string; value: string }> };
export const applyGlossary = impl.applyGlossary as (text: string, sourceLang: 'en'|'hi'|'gu', targetLang: 'en'|'hi'|'gu', terms: any[]) => string;
export const translateWithProvider = impl.translateWithProvider as (text: string, sourceLang: 'en'|'hi'|'gu', targetLang: 'en'|'hi'|'gu') => Promise<any>;
export const qaCheck = impl.qaCheck as (sourcePre: any, translatedPre: string) => any;
export const scoreTranslation = impl.scoreTranslation as (checks: any) => number;
export const shouldApprove = impl.shouldApprove as (score: number) => boolean;
export const generateTranslationsForBroadcastItem = impl.generateTranslationsForBroadcastItem as (itemId: string) => Promise<any>;
