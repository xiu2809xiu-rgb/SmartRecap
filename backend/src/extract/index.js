import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { extractText, getDocumentProxy } from 'unpdf';
import { ocrImage, ocrPdf } from './textract.js';
import { badRequest } from '../lib/http.js';

/**
 * Getting text out of whatever the student uploaded.
 *
 * The unit of extraction is a *page or slide*, not a document. That is the
 * whole reason citation is possible later: if you flatten a 24-slide deck into
 * one string, there is nothing left to cite. Every extractor below returns
 * `[{ label, page, text }]` and the label is what the reader eventually shows
 * on a citation chip.
 *
 * Scans are the interesting case. A PDF exported from PowerPoint has a text
 * layer; a PDF that is photographs of a whiteboard does not, and neither does a
 * phone photo of handwritten notes. Rather than failing on those, low text
 * density routes to Amazon Textract — which is available in Learner Lab, unlike
 * Bedrock.
 */

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
});

/** Text below this per page usually means a scan rather than a sparse slide. */
const OCR_TRIGGER_CHARS_PER_PAGE = 40;

const clean = (s) =>
  String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Depth-first collection of every value under the given tag name. */
function collectText(node, tag, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, tag, out);
    return out;
  }
  if (typeof node !== 'object') return out;

  for (const [key, value] of Object.entries(node)) {
    if (key === tag) {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) {
        for (const v of value) out.push(typeof v === 'string' ? v : (v?.['#text'] ?? ''));
      } else if (value && typeof value === 'object') out.push(value['#text'] ?? '');
    } else {
      collectText(value, tag, out);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- PDF */

async function fromPdf(buffer, { key }) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map(clean);

  const totalChars = pages.reduce((n, p) => n + p.length, 0);
  const density = totalChars / Math.max(1, totalPages);

  if (density < OCR_TRIGGER_CHARS_PER_PAGE) {
    // No usable text layer — the pages are images.
    const ocrPages = await ocrPdf(key);
    if (ocrPages.length) {
      return {
        pages: ocrPages.map((t, i) => ({ label: `Page ${i + 1}`, page: i + 1, text: clean(t) })),
        pageCount: ocrPages.length,
        ocr: true,
      };
    }
  }

  return {
    pages: pages.map((t, i) => ({ label: `Page ${i + 1}`, page: i + 1, text: t })),
    pageCount: totalPages,
    ocr: false,
  };
}

/* --------------------------------------------------------------------- PPTX */

async function fromPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // slide10.xml must not sort before slide2.xml.
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  if (!slideFiles.length) throw badRequest('That PowerPoint file has no readable slides.');

  const pages = [];
  for (let i = 0; i < slideFiles.length; i += 1) {
    const parsed = xml.parse(await zip.file(slideFiles[i]).async('string'));
    // a:t is the text run inside DrawingML — it covers titles, bullets,
    // text boxes and table cells alike.
    const runs = collectText(parsed, 'a:t').map(clean).filter(Boolean);

    // Speaker notes are often where the actual explanation lives.
    const notesName = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    let notes = [];
    if (zip.files[notesName]) {
      notes = collectText(xml.parse(await zip.file(notesName).async('string')), 'a:t').map(clean).filter(Boolean);
    }

    const text = clean([runs.join('\n'), notes.length ? `Speaker notes: ${notes.join(' ')}` : ''].filter(Boolean).join('\n\n'));
    pages.push({ label: `Slide ${i + 1}`, page: i + 1, text });
  }

  return { pages, pageCount: pages.length, ocr: false };
}

/* --------------------------------------------------------------------- DOCX */

async function fromDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw badRequest('That Word file could not be read.');

  const parsed = xml.parse(await doc.async('string'));
  const body = parsed?.['w:document']?.['w:body'] ?? parsed;
  const paragraphs = Array.isArray(body?.['w:p']) ? body['w:p'] : body?.['w:p'] ? [body['w:p']] : [];

  const blocks = paragraphs.map((p) => clean(collectText(p, 'w:t').join(''))).filter(Boolean);

  // A Word document has no page breaks we can see without rendering it, so it
  // is grouped into blocks of roughly a page's worth of prose. The label says
  // "Section" rather than "Page" so it never claims precision it does not have.
  const PER_SECTION = 8;
  const pages = [];
  for (let i = 0; i < blocks.length; i += PER_SECTION) {
    const n = pages.length + 1;
    pages.push({ label: `Section ${n}`, page: n, text: blocks.slice(i, i + PER_SECTION).join('\n\n') });
  }

  if (!pages.length) throw badRequest('That Word file appears to be empty.');
  return { pages, pageCount: pages.length, ocr: false };
}

/* -------------------------------------------------------------------- plain */

function fromPlainText(buffer) {
  const text = clean(buffer.toString('utf8'));
  if (!text) throw badRequest('That file is empty.');

  // Split on blank lines, then regroup so each chunk is substantial enough to
  // be worth citing on its own.
  const paragraphs = text.split(/\n\s*\n/).map(clean).filter(Boolean);
  const PER_SECTION = 6;
  const pages = [];
  for (let i = 0; i < paragraphs.length; i += PER_SECTION) {
    const n = pages.length + 1;
    pages.push({ label: `Section ${n}`, page: n, text: paragraphs.slice(i, i + PER_SECTION).join('\n\n') });
  }
  return { pages, pageCount: pages.length, ocr: false };
}

/* -------------------------------------------------------------------- image */

async function fromImage(buffer) {
  const text = clean(await ocrImage(buffer));
  if (!text) throw badRequest('No text could be read from that image. A sharper, better-lit photo usually fixes it.');
  return { pages: [{ label: 'Photo', page: 1, text }], pageCount: 1, ocr: true };
}

/* ------------------------------------------------------------------ dispatch */

export async function extractDocument({ buffer, fileName, key }) {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';

  switch (ext) {
    case 'pdf':
      return fromPdf(buffer, { key });
    case 'pptx':
    case 'ppt':
      return fromPptx(buffer);
    case 'docx':
    case 'doc':
      return fromDocx(buffer);
    case 'txt':
    case 'md':
      return fromPlainText(buffer);
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
      return fromImage(buffer);
    default:
      throw badRequest(`SmartRecap cannot read .${ext} files yet. Try PDF, PowerPoint, Word, plain text or an image.`);
  }
}

export { OCR_TRIGGER_CHARS_PER_PAGE };
