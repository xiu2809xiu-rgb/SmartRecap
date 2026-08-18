/** A missing `type` on a question predates multi-select/short-answer support and means "single". */
export const questionType = (question) => question?.type ?? 'single';

/** True only when both sets contain exactly the same values, order-independent. */
export function exactSetMatch(submitted, expected) {
  if (!Array.isArray(submitted) || !Array.isArray(expected)) return false;
  const submittedSet = new Set(submitted);
  const expectedSet = new Set(expected);
  return (
    submittedSet.size === submitted.length &&
    submittedSet.size === expectedSet.size &&
    [...expectedSet].every((value) => submittedSet.has(value))
  );
}
