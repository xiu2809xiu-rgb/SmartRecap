import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfPerPage } from '../src/extract/index.js';

/**
 * Per-page PDF extraction, tested against a real (hand-built, minimal) PDF
 * rather than a mock — same convention `extract.test.mjs` uses for pptx/docx.
 *
 * Only the text-layer path is exercised here: a page with a real text stream
 * has enough density that `extractPdfPerPage` never calls Textract, so this
 * covers the "text_layer" outcome without touching AWS. The OCR and mixed
 * paths are integration-only (they need a real Textract call against S3) and
 * are exercised manually per the task instructions, not in this unit test.
 */

/** A minimal, valid, N-page PDF with a real text-layer content stream per page. */
function makeTextPdf(pageTexts) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageNums = [];
  const kidsPlaceholderIndex = objects.length + 1; // Pages object comes next
  const pagesNum = kidsPlaceholderIndex;
  objects.push(null); // reserve slot for /Pages, filled in after page numbers are known

  for (const text of pageTexts) {
    // Repeat the sentence enough times that per-page char density clears the
    // OCR trigger threshold (40 chars/page) with real margin.
    const content = Array.from({ length: 6 }, () => text).join(' ');
    const stream = `BT /F1 12 Tf 72 720 Td (${content.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    const contentNum = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageNum = add(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    pageNums.push(pageNum);
  }

  objects[pagesNum - 1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`;
  const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

test('extractPdfPerPage: a text-layer PDF needs no OCR on any page', async () => {
  const buffer = makeTextPdf(['Normalisation reduces redundancy.', 'Joins combine rows from two tables.']);
  const { pages, pageCount, extractionMethod } = await extractPdfPerPage(buffer, 'unused-key');

  assert.equal(pageCount, 2);
  assert.equal(extractionMethod, 'text_layer');
  assert.equal(pages.length, 2);
  assert.ok(pages.every((p) => p.ocr === false));
  assert.match(pages[0].text, /Normalisation/);
  assert.match(pages[1].text, /Joins/);
  assert.deepEqual(pages.map((p) => p.label), ['Page 1', 'Page 2']);
});
