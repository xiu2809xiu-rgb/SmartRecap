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

// Shown to a student on the processing screen, so they say what is happening in
// their terms rather than ours. The infrastructure detail belongs in the logs
// and in docs/ARCHITECTURE.md, not on a screen someone is waiting at.
const STAGES = [
  { id: 'upload', label: 'Uploading your file', weight: 5 },
  { id: 'extract', label: 'Reading the text', weight: 20 },
  { id: 'chunk', label: 'Sorting it by slide', weight: 5 },
  { id: 'recap', label: 'Writing your recap', weight: 35 },
  { id: 'quiz', label: 'Writing your quiz', weight: 25 },
  { id: 'ground', label: 'Checking every claim', weight: 5 },
  { id: 'store', label: 'Saving to your library', weight: 5 },
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
    await record('upload', STAGES[0].label, 'Stored privately — only you can open it');
    const buffer = await getObjectBytes(key);

    /* -------------------------------------------------------- 2. extract */
    await record('extract', STAGES[1].label, 'Keeping track of which slide each part came from');
    const { pages, pageCount, ocr } = await extractDocument({ buffer, fileName, key });
    // A scan or a photo has no selectable text, so the words are read off the
    // image instead. Worth surfacing, because it is noticeably slower.
    if (ocr) await record('extract', 'No selectable text — reading it off the page', `${pageCount} pages read`);

    /* ---------------------------------------------------------- 3. chunk */
    await record('chunk', STAGES[2].label, 'So every point can link back to where it came from');
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
        `This file is long — covering ${chunks.length} of ${allChunks.length} sections`,
        `${dropped} were left out, spread evenly so the whole file is still represented`,
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
    await record('recap', STAGES[3].label, 'Every point has to name the slide it came from');
    const { recap, meta: recapMeta, report: recapReport } = await generateRecap({ chunks, mode, moduleName, onAttempt });

    /* ----------------------------------------------------------- 5. quiz */
    await record('quiz', STAGES[4].label, `${quizLength} questions, every answer traced back to your material`);
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
    await record('store', STAGES[6].label, 'Recap, quiz and sources');

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
