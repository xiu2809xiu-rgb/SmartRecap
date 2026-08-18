import { keys, getItem, putItem, updateItem } from '../lib/db.js';
import { getObjectBytes } from '../lib/s3.js';
import { extractDocument } from '../extract/index.js';
import { chunkPages, fitToBudget } from '../extract/chunk.js';
import { generateRecap, generateQuiz } from '../ai/generate.js';

/**
 * The generation pipeline, as one callable function.
 *
 * Both hosts run exactly this code; only how it gets started differs.
 *
 *   Lambda — API Gateway caps a request at 29 seconds and this takes 20-40, so
 *            `POST /jobs` invokes a second function with `InvocationType: Event`
 *            and returns immediately.
 *   EC2    — the process is long-lived, so `POST /jobs` just calls this without
 *            awaiting it. No second service, no invoke permission needed.
 *
 * Either way progress is written to the job row in DynamoDB after every stage
 * and the client polls `GET /jobs/{id}`. The stage ids below are the same ones
 * the frontend renders, which is what lets the mascot's animation state track
 * what the backend is actually doing rather than a timer.
 */

const STAGES = [
  { id: 'upload', label: 'Reading the uploaded file', weight: 5 },
  { id: 'extract', label: 'Extracting text layer', weight: 20 },
  { id: 'chunk', label: 'Segmenting into citable chunks', weight: 5 },
  { id: 'recap', label: 'Generating structured recap', weight: 35 },
  { id: 'quiz', label: 'Writing quiz items', weight: 25 },
  { id: 'ground', label: 'Verifying claims against source', weight: 5 },
  { id: 'store', label: 'Saving to DynamoDB', weight: 5 },
];

export const PIPELINE_STAGES = STAGES;

function progressThrough(stageId) {
  const index = STAGES.findIndex((s) => s.id === stageId);
  return Math.min(99, STAGES.slice(0, index).reduce((n, s) => n + s.weight, 0));
}

export async function runPipeline({ jobId, userId, materialId, fileName, key, mode, moduleName, quizLength }) {
  const startedAt = Date.now();
  const log = [];

  const record = async (stage, message, detail) => {
    log.push({ at: Date.now(), stage, message, ...(detail ? { detail } : null) });
    await updateItem(keys.job(jobId), {
      stage,
      stageLabel: message,
      progress: progressThrough(stage),
      log,
      status: 'running',
    });
  };

  const fail = async (message) => {
    console.error('Pipeline failed', jobId, message);
    await updateItem(keys.job(jobId), { status: 'failed', stage: 'failed', error: message, log });
    await updateItem(keys.material(userId, materialId), { status: 'failed', error: message });
  };

  try {
    /* ---------------------------------------------------------- 1. fetch */
    await record('upload', STAGES[0].label, 'Reading from the private S3 bucket');
    const buffer = await getObjectBytes(key);

    /* -------------------------------------------------------- 2. extract */
    await record('extract', STAGES[1].label, 'Page and slide boundaries preserved');
    const { pages, pageCount, ocr } = await extractDocument({ buffer, fileName, key });
    if (ocr) await record('extract', 'No text layer found — running Amazon Textract', `${pageCount} pages OCR'd`);

    /* ---------------------------------------------------------- 3. chunk */
    await record('chunk', STAGES[2].label, 'Each chunk keeps its slide number');
    const allChunks = chunkPages(pages);
    if (!allChunks.length) {
      await fail('No readable text was found in that file. If it is a scan, try a sharper copy.');
      return;
    }

    const { chunks, dropped, sampled } = fitToBudget(allChunks);
    if (sampled) {
      // Never silently summarise part of a file and present it as the whole.
      await record(
        'chunk',
        `Sampled ${chunks.length} of ${allChunks.length} chunks to fit the model's context`,
        `${dropped} chunks were left out, spread evenly across the document`,
      );
    }

    const onAttempt = (info) => {
      if (info.status === 'failed') {
        log.push({ at: Date.now(), stage: 'recap', message: `${info.provider} failed — falling back`, detail: info.reason });
      } else if (info.status === 'repairing') {
        log.push({ at: Date.now(), stage: 'recap', message: 'Output failed validation — asking for a repair', detail: info.reason });
      }
    };

    /* ---------------------------------------------------------- 4. recap */
    await record('recap', STAGES[3].label, 'Constrained JSON, citations required');
    const { recap, meta: recapMeta, report: recapReport } = await generateRecap({ chunks, mode, moduleName, onAttempt });

    /* ----------------------------------------------------------- 5. quiz */
    await record('quiz', STAGES[4].label, `${quizLength} questions, every option traced to a chunk`);
    const { quiz, meta: quizMeta, report: quizReport } = await generateQuiz({
      chunks,
      count: quizLength,
      moduleName,
      onAttempt,
    });

    /* --------------------------------------------------------- 6. ground */
    // Grounding already ran inside generate.js. This stage reports what it did,
    // because "we dropped two claims" is information the student should see.
    await record(
      'ground',
      STAGES[5].label,
      `${recapReport.kept} points kept, ${recapReport.dropped} dropped; ${quizReport.kept} questions kept, ${quizReport.removed} removed`,
    );

    /* ---------------------------------------------------------- 7. store */
    await record('store', STAGES[6].label, 'Recap, quiz and chunk index');

    const existing = (await getItem(keys.material(userId, materialId))) ?? {};
    const material = {
      ...existing,
      ...keys.material(userId, materialId),
      id: materialId,
      title: existing.title ?? fileName.replace(/\.[^.]+$/, ''),
      fileName,
      fileType: fileName.split('.').pop()?.toLowerCase() ?? 'pdf',
      sizeBytes: buffer.length,
      module: moduleName || 'Unfiled',
      mode,
      status: 'ready',
      pageCount,
      ocr,
      s3Key: key,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      chunks,
      recap,
      quiz,
      provider: {
        name: recapMeta.provider,
        model: recapMeta.model,
        latencyMs: recapMeta.latencyMs + quizMeta.latencyMs,
        tokensIn: recapMeta.tokensIn + quizMeta.tokensIn,
        tokensOut: recapMeta.tokensOut + quizMeta.tokensOut,
        costUsd: recapMeta.costUsd + quizMeta.costUsd,
      },
      pipeline: {
        totalMs: Date.now() - startedAt,
        chunksExtracted: allChunks.length,
        chunksUsed: chunks.length,
        sampled,
        ocr,
        pointsKept: recapReport.kept,
        pointsDropped: recapReport.dropped,
        questionsKept: quizReport.kept,
        questionsRemoved: quizReport.removed,
        questionsUnverified: quizReport.unverified,
        repaired: recapReport.repaired || quizReport.repaired,
      },
    };

    await putItem(material);
    await updateItem(keys.job(jobId), { status: 'ready', stage: 'done', progress: 100, log });
    console.log('Pipeline complete', { jobId, ms: Date.now() - startedAt, ...material.pipeline });
  } catch (e) {
    await fail(e?.message ?? 'Processing failed unexpectedly.');
  }
}
