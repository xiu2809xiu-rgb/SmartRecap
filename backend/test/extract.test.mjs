import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractDocument } from '../src/extract/index.js';
import { chunkPages, fitToBudget } from '../src/extract/chunk.js';
import { groundRecap, groundQuiz } from '../src/ai/ground.js';

/**
 * Extraction and grounding, tested against real file bytes rather than mocks.
 *
 *   node --test test/
 *
 * These are the two places where a silent regression is expensive: extraction
 * because a wrong page label makes every citation subtly wrong, and grounding
 * because it is the check the entire product claim rests on.
 */

/* ------------------------------------------------------------- fixtures */

/** A real .pptx is a zip of XML. This builds the minimum one that parses. */
async function makePptx(slides) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  slides.forEach((runs, i) => {
    const body = runs
      .map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`)
      .join('');
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeDocx(paragraphs) {
  const zip = new JSZip();
  const body = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const long = (subject, n = 5) =>
  Array.from({ length: n }, (_, i) => `${subject} point ${i + 1} explains the concept in enough words to be a real chunk.`).join(' ');

/* ---------------------------------------------------------------- tests */

test('pptx: slide numbers survive extraction', async () => {
  const buffer = await makePptx([
    ['Normalisation', long('Normalisation')],
    ['Functional dependencies', long('Dependencies')],
    ['Joins', long('Joins')],
  ]);
  const { pages, pageCount } = await extractDocument({ buffer, fileName: 'deck.pptx', key: 'x' });

  assert.equal(pageCount, 3);
  assert.deepEqual(
    pages.map((p) => p.label),
    ['Slide 1', 'Slide 2', 'Slide 3'],
  );
  assert.match(pages[0].text, /Normalisation/);
  assert.match(pages[2].text, /Joins/);
});

test('pptx: slide 10 does not sort before slide 2', async () => {
  const buffer = await makePptx(Array.from({ length: 12 }, (_, i) => [`Topic ${i + 1}`, long(`Topic ${i + 1}`)]));
  const { pages } = await extractDocument({ buffer, fileName: 'deck.pptx', key: 'x' });

  // Lexical sorting would put slide10 second. This is the regression that makes
  // every citation on a deck over nine slides point at the wrong place.
  assert.match(pages[1].text, /Topic 2\b/);
  assert.match(pages[9].text, /Topic 10\b/);
});

test('docx: paragraphs group into labelled sections', async () => {
  const buffer = await makeDocx(Array.from({ length: 20 }, (_, i) => long(`Paragraph ${i + 1}`, 2)));
  const { pages } = await extractDocument({ buffer, fileName: 'notes.docx', key: 'x' });

  assert.ok(pages.length >= 2);
  // "Section", not "Page" — a .docx has no page breaks we can see without
  // rendering it, so the label must not claim precision it does not have.
  assert.match(pages[0].label, /^Section 1$/);
});

test('plain text: empty file is rejected with a usable message', async () => {
  await assert.rejects(
    () => extractDocument({ buffer: Buffer.from('   '), fileName: 'notes.txt', key: 'x' }),
    /empty/i,
  );
});

test('unknown extension names the formats that do work', async () => {
  await assert.rejects(
    () => extractDocument({ buffer: Buffer.from('x'), fileName: 'notes.pages', key: 'x' }),
    /PDF, PowerPoint, Word/,
  );
});

test('chunking: thin pages merge, empty pages are skipped without renumbering', () => {
  const chunks = chunkPages([
    { label: 'Slide 1', page: 1, text: 'Title' }, // too short — dropped
    { label: 'Slide 2', page: 2, text: long('Normalisation') },
    { label: 'Slide 3', page: 3, text: '' }, // empty — dropped
    { label: 'Slide 4', page: 4, text: long('Joins') },
  ]);

  assert.equal(chunks.length, 2);
  // The label must still say Slide 4, not Slide 2 — renumbering would make the
  // citation point at a slide the student never saw.
  assert.deepEqual(chunks.map((c) => c.label), ['Slide 2', 'Slide 4']);
  assert.deepEqual(chunks.map((c) => c.id), ['c1', 'c2']);
});

test('budget: sampling spreads across the document and reports what it dropped', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    label: `Slide ${i + 1}`,
    page: i + 1,
    text: long(`Topic ${i + 1}`, 6),
  }));
  const { chunks, dropped, sampled } = fitToBudget(chunkPages(many), 10_000);

  assert.equal(sampled, true);
  assert.ok(dropped > 0);
  // Evenly sampled, not truncated: the end of the deck must still be covered.
  const lastPage = Number(chunks.at(-1).label.match(/\d+/)[0]);
  assert.ok(lastPage > 150, `expected coverage near the end, got Slide ${lastPage}`);
  assert.deepEqual(chunks.map((c) => c.id).slice(0, 3), ['c1', 'c2', 'c3']);
});

/* ------------------------------------------------------------- grounding */

const CHUNKS = [
  { id: 'c1', label: 'Slide 2', page: 2, text: 'Normalisation reduces data redundancy and prevents update anomalies in a relational database.' },
  { id: 'c2', label: 'Slide 5', page: 5, text: 'A primary key uniquely identifies each row in a table and cannot contain NULL values.' },
];

test('grounding: an invented chunk id drops the claim and records why', () => {
  const { recap, report } = groundRecap(
    {
      summary: 's',
      sections: [
        {
          id: 's1',
          heading: 'H',
          points: [
            { id: 'p1', text: 'Normalisation reduces redundancy and prevents update anomalies.', citations: ['c1'] },
            { id: 'p2', text: 'Indexes always improve write performance.', citations: ['c99'] },
          ],
        },
      ],
    },
    CHUNKS,
  );

  assert.equal(report.kept, 1);
  assert.equal(report.dropped, 1);
  assert.equal(recap.sections[0].points.length, 1);
  assert.match(recap.ungrounded[0].reason, /no chunk with that id/i);
});

test('grounding: a true claim citing the wrong slide is still dropped', () => {
  const { recap, report } = groundRecap(
    {
      summary: 's',
      sections: [
        {
          id: 's1',
          heading: 'H',
          points: [
            // True, and c2 exists — but c2 is about primary keys, not joins.
            // Resolution alone would let this through; overlap catches it.
            { id: 'p1', text: 'A LEFT JOIN returns every row from the left table padded with NULL.', citations: ['c2'] },
          ],
        },
      ],
    },
    CHUNKS,
  );

  assert.equal(report.kept, 0);
  assert.equal(report.dropped, 1);
  assert.match(recap.ungrounded[0].reason, /does not discuss this/i);
});

test('grounding: an uncited claim never reaches the recap', () => {
  const { recap } = groundRecap(
    { summary: 's', sections: [{ id: 's1', heading: 'H', points: [{ id: 'p1', text: 'Anything at all.', citations: [] }] }] },
    CHUNKS,
  );

  assert.equal(recap.sections.length, 0); // the whole empty section goes too
  assert.match(recap.ungrounded[0].reason, /no citation/i);
});

test('quiz grounding: an out-of-range answer index is removed', () => {
  const { quiz, report } = groundQuiz(
    {
      questions: [
        {
          id: 'q1',
          topic: 'Keys',
          prompt: 'What does a primary key do?',
          options: ['Identifies each row uniquely', 'b', 'c', 'd'],
          answer: 0,
          citations: ['c2'],
          verified: true,
        },
        { id: 'q2', topic: 'X', prompt: 'Broken', options: ['a', 'b', 'c', 'd'], answer: 9, citations: ['c1'] },
      ],
    },
    CHUNKS,
  );

  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(quiz.questions[0].id, 'q1');
});
