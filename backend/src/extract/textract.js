import {
  TextractClient,
  DetectDocumentTextCommand,
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
} from '@aws-sdk/client-textract';

/**
 * OCR, for material that has no text layer.
 *
 * This is the path for a photo of handwritten lecture notes, or a PDF that is
 * really a stack of scans. Textract is available inside AWS Academy Learner Lab
 * — Bedrock is not — so it is genuine AWS AI in the pipeline rather than a
 * service named on a slide.
 *
 * Two different APIs, because Textract splits them:
 *  - Images are synchronous, one call, done in a second.
 *  - PDFs are asynchronous: start a job, poll for it. The processor Lambda has
 *    a 300-second budget, which is what bounds the wait below.
 */

const textract = new TextractClient({});
const BUCKET = () => process.env.BUCKET_NAME;

const linesOf = (blocks = []) =>
  blocks
    .filter((b) => b.BlockType === 'LINE')
    .map((b) => b.Text)
    .filter(Boolean);

/** Synchronous OCR for a single image. Textract accepts raw bytes here. */
export async function ocrImage(buffer) {
  const res = await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: buffer } }));
  return linesOf(res.Blocks).join('\n');
}

const POLL_INTERVAL_MS = 2500;
const MAX_WAIT_MS = 180_000;

/**
 * Asynchronous OCR for a multi-page PDF already sitting in S3.
 * Returns one string per page, or an empty array if the job does not finish in
 * time — the caller then falls back to whatever text layer it did find rather
 * than failing the whole upload.
 */
export async function ocrPdf(key) {
  const start = await textract.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: { S3Object: { Bucket: BUCKET(), Name: key } },
    }),
  );
  const jobId = start.JobId;
  if (!jobId) return [];

  const deadline = Date.now() + MAX_WAIT_MS;
  const blocks = [];

  for (;;) {
    if (Date.now() > deadline) {
      console.warn('Textract job exceeded the wait budget', jobId);
      return [];
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    let nextToken;
    let status;
    // A finished job can span several result pages; collect them all.
    do {
      const res = await textract.send(new GetDocumentTextDetectionCommand({ JobId: jobId, NextToken: nextToken }));
      status = res.JobStatus;
      if (status === 'SUCCEEDED') blocks.push(...(res.Blocks ?? []));
      nextToken = res.NextToken;
    } while (nextToken && status === 'SUCCEEDED');

    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'PARTIAL_SUCCESS') {
      console.warn('Textract job did not succeed', jobId, status);
      return [];
    }
    // IN_PROGRESS — loop and poll again.
  }

  // Regroup LINE blocks by the page they came from.
  const byPage = new Map();
  for (const b of blocks) {
    if (b.BlockType !== 'LINE' || !b.Text) continue;
    const page = b.Page ?? 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(b.Text);
  }

  return [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, lines]) => lines.join('\n'));
}
