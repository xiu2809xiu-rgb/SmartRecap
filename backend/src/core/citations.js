/**
 * Resolving citations from chunk ids to source identity.
 *
 * `ground.js` already validates that a citation resolves to a real chunk and
 * that the claim actually overlaps that chunk's text — see the note at the
 * top of that file. What it cannot say is *which file* the chunk came from,
 * because a single-Material pipeline never needs to: there is only one file.
 * A Binder can hold several, and "page 12" is ambiguous the moment it does.
 *
 * This module runs one step further than grounding, only for a Binder: it
 * takes the already-grounded chunk-id citations and resolves each one to
 * `{ sourceId, displayName, page }`. The model is never shown a source id and
 * never emits one — it only ever sees `chunk.sourceRef` (a short "S1", "S2"
 * marker baked into each chunk's label by `core/binderPipeline.js`), and
 * everything it cites is a chunk id it copied verbatim from the material it
 * was sent. This module is the only place a ref or a chunk id turns into real
 * identity, which is what keeps that identity out of the prompt entirely.
 */

/**
 * Assigns each source a short ref ("S1", "S2", ...) in the given order.
 * Order matters and is the caller's to fix — `binderPipeline.js` uses ready-
 * source list order, so the same ref always points at the same source for a
 * single generation run.
 */
export function buildRefMap(sources) {
  const refMap = new Map(); // ref -> { id, displayName, pageCount }
  const sourceRefById = new Map(); // sourceId -> ref
  sources.forEach((source, i) => {
    const ref = `S${i + 1}`;
    refMap.set(ref, source);
    sourceRefById.set(source.id, ref);
  });
  return { refMap, sourceRefById };
}

/**
 * Resolves one citation list (chunk ids) to source identity.
 *
 * Validation, in order, matching the acceptance criteria:
 *   1. A chunk id that does not resolve to a real chunk, or whose chunk has
 *      no `sourceRef`, or whose ref is not in `refMap` — dropped.
 *   2. A resolved page number beyond that source's `pageCount` — dropped.
 *      In practice `chunk.page` is always a real page extracted from that
 *      exact source, so this should never fire from live data; it exists as
 *      the same defensive check the spec asks for, and is covered directly by
 *      a unit test rather than relying on triggering it through the full
 *      pipeline.
 *
 * Two citations that land on the same source and page (two different chunks
 * on one page, both cited) collapse to one chip — repeating "p.12" twice next
 * to one point reads as a bug, not as two sources of support.
 */
export function resolveCitations(chunkIds, chunkById, refMap) {
  const resolved = [];
  let droppedInvalidRef = 0;
  let droppedPageRange = 0;

  for (const chunkId of chunkIds ?? []) {
    const chunk = chunkById.get(chunkId);
    const source = chunk?.sourceRef ? refMap.get(chunk.sourceRef) : undefined;
    if (!chunk || !source) {
      droppedInvalidRef += 1;
      continue;
    }
    if (Number.isFinite(source.pageCount) && source.pageCount > 0 && chunk.page > source.pageCount) {
      droppedPageRange += 1;
      continue;
    }
    resolved.push({ sourceId: source.id, displayName: source.displayName, page: chunk.page });
  }

  const seen = new Set();
  const deduped = resolved.filter((c) => {
    const key = `${c.sourceId}:${c.page}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { resolved: deduped, droppedInvalidRef, droppedPageRange };
}

/**
 * Runs `resolveCitations` over every citation-bearing field of a Binder's
 * recap and quiz, and builds the per-source citation-count summary shown
 * above the recap.
 *
 * A point, key term or question that loses every citation is kept — dropping
 * it a second time here would silently shrink a recap `ground.js` already
 * decided was safe to show — but is marked `unverified: true` rather than
 * left indistinguishable from a fully-resolved one.
 */
export function resolveRecapCitations({ recap, quiz, chunks, refMap }) {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const sources = [...refMap.values()];
  const counts = new Map(sources.map((s) => [s.id, 0]));

  let totalResolved = 0;
  let totalDroppedInvalidRef = 0;
  let totalDroppedPageRange = 0;

  const apply = (citations) => {
    const { resolved, droppedInvalidRef, droppedPageRange } = resolveCitations(citations, chunkById, refMap);
    totalResolved += resolved.length;
    totalDroppedInvalidRef += droppedInvalidRef;
    totalDroppedPageRange += droppedPageRange;
    for (const c of resolved) counts.set(c.sourceId, (counts.get(c.sourceId) ?? 0) + 1);
    return resolved;
  };

  const sections = (recap.sections ?? []).map((section) => ({
    ...section,
    points: (section.points ?? []).map((point) => {
      const resolvedCitations = apply(point.citations);
      return { ...point, resolvedCitations, unverified: resolvedCitations.length === 0 };
    }),
  }));

  const keyTerms = (recap.keyTerms ?? []).map((term) => {
    const resolvedCitations = apply(term.citations);
    return { ...term, resolvedCitations, unverified: resolvedCitations.length === 0 };
  });

  const questions = (quiz?.questions ?? []).map((question) => {
    const resolvedCitations = apply(question.citations);
    return { ...question, resolvedCitations, unverified: resolvedCitations.length === 0 };
  });

  const sourcesSummary = sources.map((s) => ({
    sourceId: s.id,
    displayName: s.displayName,
    pageCount: s.pageCount,
    citationCount: counts.get(s.id) ?? 0,
  }));

  // High drop rates mean the prompt or extraction is failing — this is the
  // one line an operator needs to notice that in CloudWatch.
  console.log('Citation resolution', {
    resolved: totalResolved,
    droppedInvalidRef: totalDroppedInvalidRef,
    droppedPageRange: totalDroppedPageRange,
  });

  return {
    recap: { ...recap, sections, keyTerms },
    quiz: quiz ? { ...quiz, questions } : quiz,
    sourcesSummary,
  };
}
