/**
 * The languages a recap can be read in.
 *
 * Singapore has four official languages and a polytechnic cohort does not all
 * think in the same one, so those four are the set. English is the default
 * because that is what the lecture material is almost always written in — and
 * `en` is not a translation at all, it is the absence of one.
 *
 * `src/lib/languages.js` on the frontend carries the same list. It is
 * duplicated rather than imported because the two are separate builds; if you
 * add a language, add it in both places.
 */

export const LANGUAGES = [
  { code: 'en', label: 'English', endonym: 'English' },
  { code: 'zh', label: 'Chinese (Simplified)', endonym: '简体中文' },
  { code: 'ms', label: 'Malay', endonym: 'Bahasa Melayu' },
  { code: 'ta', label: 'Tamil', endonym: 'தமிழ்' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Unknown or missing codes fall back to English rather than failing a job. */
export const normaliseLanguage = (code) => (BY_CODE.has(String(code)) ? String(code) : 'en');

export const languageName = (code) => BY_CODE.get(normaliseLanguage(code))?.label ?? 'English';
