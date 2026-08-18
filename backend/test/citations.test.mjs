import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkPages } from '../src/extract/chunk.js';
import { buildRefMap, resolveCitations, resolveRecapCitations } from '../src/core/citations.js';

/**
 * Citation attribution: source-aware chunking plus server-side ref resolution.
 *
 * This is the feature the acceptance criteria are written against — a chunk
 * must never straddle two sources, a citation must resolve to a real source
 * and a page within that source's range, and a point that loses every
 * citation must be kept but marked unverified rather than silently dropped a
 * second time.
 */

const long = (subject, n = 5) =>
  Array.from({ length: n }, (_, i) => `${subject} point ${i + 1} explains the concept in enough words to be a real chunk.`).join(' ');

// Between MIN_CHARS (60) and MERGE_UNDER (260) so a page is real text but
// still short enough to become a "pending" merge candidate rather than being
// dropped as a title slide or split on its own.
const thin = (label) => `${label} is a short passage, long enough to count as real content but short enough to merge.`;

test('chunkPages: a thin page never merges across a source boundary', () => {
  const chunks = chunkPages([
    { label: 'Slide 1', page: 1, text: thin('Intro'), sourceRef: 'S1' }, // thin, pending
    { label: 'Slide 1', page: 1, text: thin('Different file'), sourceRef: 'S2' }, // thin, different source
  ]);

  // Without the source-boundary rule these two would merge into one chunk
  // that is genuinely two files' text glued together.
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].sourceRef, 'S1');
  assert.equal(chunks[1].sourceRef, 'S2');
});

test('chunkPages: thin pages from the same source still merge as before', () => {
  const chunks = chunkPages([
    { label: 'Slide 1', page: 1, text: thin('Intro'), sourceRef: 'S1' },
    { label: 'Slide 2', page: 2, text: thin('Continued'), sourceRef: 'S1' },
  ]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].sourceRef, 'S1');
});

test('chunkPages: sourceRef is omitted entirely when pages do not carry one', () => {
  // Backward compatibility: a single-Material pipeline never sets sourceRef.
  const chunks = chunkPages([{ label: 'Page 1', page: 1, text: long('Normalisation') }]);
  assert.equal('sourceRef' in chunks[0], false);
});

/* ---------------------------------------------------------------- refMap */

const SOURCE_A = { id: 'src_a', displayName: 'Lecture 3 - Hashing', pageCount: 10 };
const SOURCE_B = { id: 'src_b', displayName: 'Lecture 4 - Trees', pageCount: 5 };

test('buildRefMap: assigns S1, S2 in the given order', () => {
  const { refMap, sourceRefById } = buildRefMap([SOURCE_A, SOURCE_B]);
  assert.equal(refMap.get('S1'), SOURCE_A);
  assert.equal(refMap.get('S2'), SOURCE_B);
  assert.equal(sourceRefById.get('src_a'), 'S1');
  assert.equal(sourceRefById.get('src_b'), 'S2');
});

/* ------------------------------------------------------------ resolution */

function chunkMapFrom(chunks) {
  return new Map(chunks.map((c) => [c.id, c]));
}

test('resolveCitations: a chunk id not in the sent set is dropped', () => {
  const { refMap } = buildRefMap([SOURCE_A]);
  const chunkById = chunkMapFrom([{ id: 'c1', page: 3, sourceRef: 'S1' }]);
  const { resolved, droppedInvalidRef } = resolveCitations(['c1', 'c99'], chunkById, refMap);
  assert.equal(resolved.length, 1);
  assert.equal(droppedInvalidRef, 1);
  assert.deepEqual(resolved[0], { sourceId: 'src_a', displayName: 'Lecture 3 - Hashing', page: 3 });
});

test('resolveCitations: a chunk whose ref is not in refMap is dropped', () => {
  const { refMap } = buildRefMap([SOURCE_A]); // only S1 exists
  const chunkById = chunkMapFrom([{ id: 'c1', page: 2, sourceRef: 'S2' }]);
  const { resolved, droppedInvalidRef } = resolveCitations(['c1'], chunkById, refMap);
  assert.equal(resolved.length, 0);
  assert.equal(droppedInvalidRef, 1);
});

test('resolveCitations: a page beyond the source page_count is dropped, not rendered', () => {
  const { refMap } = buildRefMap([SOURCE_A]); // pageCount: 10
  const chunkById = chunkMapFrom([{ id: 'c1', page: 11, sourceRef: 'S1' }]);
  const { resolved, droppedPageRange } = resolveCitations(['c1'], chunkById, refMap);
  assert.equal(resolved.length, 0);
  assert.equal(droppedPageRange, 1);
});

test('resolveCitations: two chunks citing the same source+page collapse to one chip', () => {
  const { refMap } = buildRefMap([SOURCE_A]);
  const chunkById = chunkMapFrom([
    { id: 'c1', page: 4, sourceRef: 'S1' },
    { id: 'c2', page: 4, sourceRef: 'S1' },
  ]);
  const { resolved } = resolveCitations(['c1', 'c2'], chunkById, refMap);
  assert.equal(resolved.length, 1);
});

test('resolveCitations: citations spanning two different sources are all kept', () => {
  const { refMap } = buildRefMap([SOURCE_A, SOURCE_B]);
  const chunkById = chunkMapFrom([
    { id: 'c1', page: 2, sourceRef: 'S1' },
    { id: 'c2', page: 3, sourceRef: 'S2' },
  ]);
  const { resolved } = resolveCitations(['c1', 'c2'], chunkById, refMap);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved.map((r) => r.sourceId).sort(), ['src_a', 'src_b']);
});

/* ------------------------------------------------------- full recap pass */

test('resolveRecapCitations: a point that loses every citation is kept but marked unverified', () => {
  const { refMap } = buildRefMap([SOURCE_A]);
  const chunks = [{ id: 'c1', page: 2, sourceRef: 'S1', label: 'x', text: 'x' }];
  const recap = {
    summary: 's',
    sections: [{ id: 's1', heading: 'H', points: [{ id: 'p1', text: 'Claim', citations: ['c99'] }] }],
    keyTerms: [],
  };
  const { recap: out } = resolveRecapCitations({ recap, quiz: null, chunks, refMap });
  const point = out.sections[0].points[0];
  assert.equal(point.unverified, true);
  assert.deepEqual(point.resolvedCitations, []);
  // The point itself must survive — dropping it again here would silently
  // shrink a recap `ground.js` already decided was safe to show.
  assert.equal(out.sections[0].points.length, 1);
});

test('resolveRecapCitations: a resolved point is not marked unverified', () => {
  const { refMap } = buildRefMap([SOURCE_A]);
  const chunks = [{ id: 'c1', page: 2, sourceRef: 'S1', label: 'x', text: 'x' }];
  const recap = {
    summary: 's',
    sections: [{ id: 's1', heading: 'H', points: [{ id: 'p1', text: 'Claim', citations: ['c1'] }] }],
    keyTerms: [],
  };
  const { recap: out } = resolveRecapCitations({ recap, quiz: null, chunks, refMap });
  const point = out.sections[0].points[0];
  assert.equal(point.unverified, false);
  assert.deepEqual(point.resolvedCitations, [{ sourceId: 'src_a', displayName: 'Lecture 3 - Hashing', page: 2 }]);
});

test('resolveRecapCitations: quiz questions get resolvedCitations too', () => {
  const { refMap } = buildRefMap([SOURCE_A]);
  const chunks = [{ id: 'c1', page: 5, sourceRef: 'S1', label: 'x', text: 'x' }];
  const recap = { summary: 's', sections: [], keyTerms: [] };
  const quiz = { questions: [{ id: 'q1', prompt: 'p', citations: ['c1'] }] };
  const { quiz: out } = resolveRecapCitations({ recap, quiz, chunks, refMap });
  assert.deepEqual(out.questions[0].resolvedCitations, [{ sourceId: 'src_a', displayName: 'Lecture 3 - Hashing', page: 5 }]);
  assert.equal(out.questions[0].unverified, false);
});

test('resolveRecapCitations: per-source citation counts sum to the total resolved', () => {
  const { refMap } = buildRefMap([SOURCE_A, SOURCE_B]);
  const chunks = [
    { id: 'c1', page: 1, sourceRef: 'S1', label: 'x', text: 'x' },
    { id: 'c2', page: 2, sourceRef: 'S1', label: 'x', text: 'x' },
    { id: 'c3', page: 1, sourceRef: 'S2', label: 'x', text: 'x' },
  ];
  const recap = {
    summary: 's',
    sections: [
      {
        id: 's1',
        heading: 'H',
        points: [
          { id: 'p1', text: 'A', citations: ['c1'] },
          { id: 'p2', text: 'B', citations: ['c2'] },
          { id: 'p3', text: 'C', citations: ['c3'] },
        ],
      },
    ],
    keyTerms: [],
  };
  const { sourcesSummary } = resolveRecapCitations({ recap, quiz: null, chunks, refMap });
  const total = sourcesSummary.reduce((n, s) => n + s.citationCount, 0);
  assert.equal(total, 3);
  assert.equal(sourcesSummary.find((s) => s.sourceId === 'src_a').citationCount, 2);
  assert.equal(sourcesSummary.find((s) => s.sourceId === 'src_b').citationCount, 1);
});
