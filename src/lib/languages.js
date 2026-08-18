/**
 * The languages a recap can be read in.
 *
 * Mirrors `backend/src/ai/languages.js` — duplicated because the two are
 * separate builds. If you add a language, add it in both places.
 *
 * The label is shown in the reader's own script rather than in English, because
 * someone looking for a Tamil recap is scanning for தமிழ், not for the word
 * "Tamil". English carries no endonym line for the same reason: to an English
 * reader it would just repeat itself.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English', endonym: null },
  { code: 'zh', label: 'Chinese (Simplified)', endonym: '简体中文' },
  { code: 'ms', label: 'Malay', endonym: 'Bahasa Melayu' },
  { code: 'ta', label: 'Tamil', endonym: 'தமிழ்' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export const languageLabel = (code) => BY_CODE.get(code)?.endonym ?? BY_CODE.get(code)?.label ?? 'English';

/** The `lang` attribute on the recap, so a screen reader switches voice with it. */
export const langAttr = (code) => (BY_CODE.has(code) ? code : 'en');
