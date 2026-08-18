import { keys, updateItem } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { loadMaterial } from './library.js';
import { generatePractice } from '../ai/generate.js';

/**
 * Coding practice drawn from a student's own material.
 *
 * The thesis is unchanged from the recap: an exercise has to come from
 * something the upload actually teaches, and has to say where. What makes it
 * worth building is the pairing — a student reading a recap of a lecture on
 * binary search can write binary search in the next column, against tests
 * derived from the same slides, without leaving the page or setting anything
 * up.
 *
 * Generated on demand and cached on the material, not produced in the pipeline.
 * Most uploads are not programming material, and spending a free-tier call on
 * exercises for a marketing deck — every time, for every upload — to then throw
 * them away is a bad trade.
 */

/**
 * Does this material contain code at all?
 *
 * A cheap local check that runs before any model call. Its job is to keep a
 * history deck from costing a request, so it errs towards saying yes — the
 * model is asked to decline as well, and does the real judging. Both have to
 * agree before a student sees exercises.
 */
/**
 * Signals are weighted because they are not equally trustworthy.
 *
 * `def greet(` or `SELECT ... FROM` cannot plausibly appear in a history deck,
 * so one occurrence settles it. "Algorithm" or "recursive" can turn up in
 * almost any subject's prose, so those need corroboration. One threshold over
 * two tiers gets both cases right, where counting every match equally got one
 * of them wrong whichever threshold was chosen.
 */
const STRONG = 2;
const WEAK = 1;
const THRESHOLD = 2;

const CODE_SIGNALS = [
  // Literal syntax — nothing else writes like this.
  [/\bdef\s+\w+\s*\(/, STRONG],
  [/\bfunction\s+\w*\s*\(/, STRONG],
  [/\b(?:const|let|var)\s+\w+\s*=/, STRONG],
  [/\bclass\s+\w+\s*[:({]/, STRONG],
  [/\bfor\s*\(.*;.*;/, STRONG],
  [/\bfor\s+\w+\s+in\s+/, STRONG],
  [/\bwhile\s*\(/, STRONG],
  [/\bif\s*\(.*\)\s*\{/, STRONG],
  [/\bimport\s+\w+/, STRONG],
  [/\b(?:public|private|static)\s+(?:void|int|String)\b/, STRONG],
  [/\bprint\s*\(|\bconsole\.log\s*\(/, STRONG],
  [/\bSELECT\b[\s\S]{0,80}\bFROM\b/i, STRONG],

  // Complexity notation, in the forms a lecture actually writes it. An earlier
  // version only matched a leading `n` and so missed `O(log n)` — the single
  // most common one on an algorithms slide.
  [/\bO\(\s*(?:1|n|log\s*n|n\s*log\s*n|n\s*\^?\s*2|n²)\s*\)/i, STRONG],

  // Vocabulary. Deliberately excludes words with strong everyday senses —
  // "stack", "queue", "function", "class", "return" — because two of those in
  // a timetable would otherwise be enough.
  [
    /\b(?:linked list|binary tree|binary search|hash table|hash function|merge sort|bubble sort|quicksort|breadth-first|depth-first|time complexity|space complexity|big-?o\b|pseudocode|recursion|recursive|data structure|algorithm)\b/i,
    WEAK,
  ],
  [/\breturn\s+(?:the\s+)?(?:value|index|result|list|array|true|false|null|none)\b/i, WEAK],
];

/**
 * Weak signals score per *distinct* term matched, not once for the whole
 * alternation. A lecture that says both "linked list" and "hash table" is real
 * evidence even with no literal code on its slides, and counting the shared
 * regex a single time would have denied that deck any practice.
 *
 * Mirrored in `backend/app/ai_service.py`'s `looks_like_code`, which is the
 * one the deployed FastAPI host actually runs.
 */
export function looksLikeCode(chunks) {
  const text = (chunks ?? []).map((c) => c.text).join('\n');
  let score = 0;
  for (const [pattern, weight] of CODE_SIGNALS) {
    if (weight >= THRESHOLD) {
      if (pattern.test(text)) score += weight;
    } else {
      const found = text.match(new RegExp(pattern.source, 'gi')) ?? [];
      score += Math.min(new Set(found.map((m) => m.toLowerCase())).size, THRESHOLD);
    }
    if (score >= THRESHOLD) return true;
  }
  return false;
}

const NOT_CODE = {
  exercises: [],
  applicable: false,
  reason: 'This material does not look like it teaches programming, so there is nothing here to practise in code.',
};

export async function getPractice(userId, materialId, { refresh = false } = {}) {
  if (!materialId) throw badRequest('materialId is required.');
  const material = await loadMaterial(userId, materialId);

  if (!refresh && material.practice) return { ...material.practice, cached: true };
  if (!material.chunks?.length) throw badRequest('That material has no extracted text to work from.');

  if (!looksLikeCode(material.chunks)) {
    // Cached like any other answer. "No" is a result, and re-deciding it on
    // every visit would cost a request to reach the same conclusion.
    await updateItem(keys.material(userId, materialId), { practice: NOT_CODE });
    return { ...NOT_CODE, cached: false };
  }

  const { practice } = await generatePractice({
    chunks: material.chunks,
    moduleName: material.module,
    language: material.language,
  });

  await updateItem(keys.material(userId, materialId), { practice });
  return { ...practice, cached: false };
}
