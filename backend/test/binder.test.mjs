import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSourceText, decodeSourceText } from '../src/extract/index.js';

/**
 * The binder text cache round trip.
 *
 * `encodeSourceText`/`decodeSourceText` are the only thing standing between
 * "OCR ran once" and "OCR ran every time Generate is clicked" — if decoding
 * loses a page or garbles text, `binderPipeline.js` would build a recap over
 * corrupted source, and there is no error to catch that because nothing
 * throws when a page silently goes missing.
 */

test('binder text cache: pages round-trip through encode/decode', () => {
  const pages = [
    { page: 1, text: 'Introduction to normalisation.\nSecond line.' },
    { page: 2, text: 'Functional dependencies define keys.' },
    { page: 3, text: 'Joins combine rows from two tables.' },
  ];

  const encoded = encodeSourceText(pages);
  const decoded = decodeSourceText(encoded);

  assert.deepEqual(decoded, pages);
});

test('binder text cache: a page with empty text still round-trips', () => {
  const pages = [
    { page: 1, text: 'Some text.' },
    { page: 2, text: '' },
    { page: 3, text: 'More text.' },
  ];

  const decoded = decodeSourceText(encodeSourceText(pages));
  assert.deepEqual(decoded, pages);
});

test('binder text cache: page numbers are preserved even with gaps', () => {
  // A source could plausibly have pages numbered non-contiguously if a future
  // caller merges partial extracts; the format must not assume page N is at
  // index N-1.
  const pages = [
    { page: 5, text: 'Page five text.' },
    { page: 9, text: 'Page nine text.' },
  ];

  const decoded = decodeSourceText(encodeSourceText(pages));
  assert.deepEqual(decoded, pages);
});

test('binder text cache: decoding an empty string yields no pages', () => {
  assert.deepEqual(decodeSourceText(''), []);
});
