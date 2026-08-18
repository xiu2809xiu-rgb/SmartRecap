import { keys, getItem, updateItem, queryPrefix } from '../lib/db.js';
import { getObjectBytes, putObject, binderTextKey } from '../lib/s3.js';
import { extractPdfPerPage, encodeSourceText } from '../extract/index.js';
import { MAX_PAGES_PER_BINDER } from './sources.js';

/**
 * Per-source ingestion: fetch the uploaded PDF, decide text-layer vs OCR on
 * every page, cache the combined text to S3, and settle the source's status.
 *
 * This is the async work `POST /binders/{id}/sources` (via `commitSource`)
 * hands to `dispatch` and returns immediately from — the same fire-and-forget
 * shape `core/pipeline.js` uses for a Material, just scoped to one file
 * instead of one whole generation.
 *
 * Never re-run for a source that already reached `ready`: `text_s3_key` is
 * the durable result, and every later `generate` call reads it rather than
 * calling back into this function. Re-extracting on every generate would
 * silently re-run OCR (slow, and a Textract cost) for no behavioural gain.
 */
export async function runSourceExtraction({ userId, binderId, sourceId }) {
  const sourceKey = keys.source(userId, binderId, sourceId);

  const fail = async (message) => {
    console.error('Source extraction failed', sourceId, message);
    await updateItem(sourceKey, { status: 'failed', errorMessage: message });
  };

  try {
    const source = await getItem(sourceKey);
    if (!source) return; // deleted mid-flight

    const buffer = await getObjectBytes(source.s3Key);
    const { pages, pageCount, extractionMethod } = await extractPdfPerPage(buffer, source.s3Key);

    if (!pages.some((p) => p.text.trim().length > 0)) {
      await fail('No readable text was found in that PDF. If it is a scan, try a sharper copy.');
      return;
    }

    // The 300-page cap is per binder, not per file, so it can only be checked
    // once this file's real page count is known — this is why the cap is
    // enforced here rather than at upload time, when other pending sources'
    // page counts are still unknown.
    const siblings = await queryPrefix(keys.sourcePrefix(userId, binderId));
    const othersPageTotal = siblings
      .filter((s) => s.id !== sourceId && s.status !== 'failed')
      .reduce((n, s) => n + (s.pageCount || 0), 0);
    const newTotal = othersPageTotal + pageCount;

    if (newTotal > MAX_PAGES_PER_BINDER) {
      await fail(
        `Adding this file would bring the binder to ${newTotal} pages, over the ${MAX_PAGES_PER_BINDER}-page limit.`,
      );
      return;
    }

    const textKey = binderTextKey(userId, binderId, sourceId);
    await putObject(textKey, encodeSourceText(pages), 'text/plain; charset=utf-8');

    await updateItem(sourceKey, {
      status: 'ready',
      extractionMethod,
      pageCount,
      textS3Key: textKey,
      errorMessage: null,
    });
  } catch (e) {
    await fail(e?.message ?? 'Extraction failed unexpectedly.');
  }
}
