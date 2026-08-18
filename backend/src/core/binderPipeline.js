import { keys, getItem, updateItem, queryPrefix } from '../lib/db.js';
import { getObjectBytes } from '../lib/s3.js';
import { decodeSourceText } from '../extract/index.js';
import { chunkPages, fitToBudget } from '../extract/chunk.js';
import { generateRecap, generateQuiz } from '../ai/generate.js';
import { buildRefMap, resolveRecapCitations } from './citations.js';

/**
 * Generates one Recap covering every `ready` source in a Binder.
 *
 * This is `core/pipeline.js`'s recap half, reused rather than duplicated —
 * the difference is where the pages come from. A Material pipeline extracts
 * one file inline; here every source has already been extracted (see
 * `core/sourceExtract.js`) and cached to `text_s3_key`, so this function's
 * only job is to read those caches back, merge them into one page list with
 * source-aware labels, and hand that to the same chunk/generate/ground path.
 *
 * Never triggers extraction itself — a source with no `text_s3_key` is
 * skipped with a warning, not re-extracted. That is the whole point of
 * caching it: running Generate twice must cost one AI call, not two OCR runs
 * plus two AI calls.
 *
 * Citation attribution: each ready source gets a short ref ("S1", "S2", ...)
 * in list order via `buildRefMap`, and every page carries its source's ref as
 * `sourceRef` before chunking — `chunkPages` keeps a chunk from ever spanning
 * two sources (see the note there). The model still only ever cites chunk
 * ids, exactly as a single-Material recap does; `resolveRecapCitations` is
 * the one place a chunk id's `sourceRef` turns into the source's real
 * `{ sourceId, displayName, page }` for the client, after grounding has
 * already decided the citation is valid. See `core/citations.js`.
 */
export async function runBinderPipeline({ jobId, userId, binderId }) {
  const log = [];

  const record = async (stage, message) => {
    log.push({ at: Date.now(), stage, message });
    await updateItem(keys.job(jobId), { stage, stageLabel: message, log, status: 'running' });
  };

  const fail = async (message) => {
    console.error('Binder pipeline failed', jobId, message);
    await updateItem(keys.job(jobId), { status: 'failed', stage: 'failed', error: message, log });
  };

  try {
    await record('read', 'Reading your sources');
    const sources = await queryPrefix(keys.sourcePrefix(userId, binderId));
    const ready = sources.filter((s) => s.status === 'ready' && s.textS3Key);

    if (!ready.length) {
      await fail('No processed sources are ready yet. Wait for at least one to finish, then try again.');
      return;
    }

    // Refs are assigned in ready-source order and stay fixed for this one run
    // — see `core/citations.js`. The model is given "[S2 p7]"-style labels,
    // never the source's real id or its full display name (which it would
    // otherwise paraphrase or truncate, breaking lookup).
    const { refMap } = buildRefMap(ready);
    const sourceRefById = new Map(ready.map((s, i) => [s.id, `S${i + 1}`]));

    // One page list across every ready source, each page carrying its
    // source's ref so a chunk can never be attributed to the wrong file.
    const allPages = [];
    for (const source of ready) {
      const sourceRef = sourceRefById.get(source.id);
      const raw = await getObjectBytes(source.textS3Key);
      const pages = decodeSourceText(raw.toString('utf8'));
      for (const p of pages) {
        allPages.push({ label: `[${sourceRef} p${p.page}] ${source.displayName}`, page: p.page, text: p.text, sourceRef });
      }
    }

    await record('chunk', 'Sorting it by source and page');
    const allChunks = chunkPages(allPages);
    if (!allChunks.length) {
      await fail('None of your ready sources had readable text to build a recap from.');
      return;
    }

    const { chunks, dropped, sampled } = fitToBudget(allChunks);
    if (sampled) {
      await record('chunk', `This binder is long — covering ${chunks.length} of ${allChunks.length} sections (${dropped} left out, spread evenly)`);
    }

    const binder = await getItem(keys.binder(userId, binderId));
    const moduleName = binder?.name ?? '';

    const onAttempt = (info) => {
      if (info.status === 'failed') log.push({ at: Date.now(), stage: 'recap', message: `${info.provider} failed — falling back`, detail: info.reason });
      else if (info.status === 'repairing') log.push({ at: Date.now(), stage: 'recap', message: 'Output failed validation — asking for a repair', detail: info.reason });
    };

    await record('recap', 'Writing your recap');
    const { recap, meta: recapMeta, report: recapReport } = await generateRecap({ chunks, mode: 'deep', moduleName, onAttempt });

    await record('quiz', 'Writing your quiz');
    const { quiz, meta: quizMeta, report: quizReport } = await generateQuiz({ chunks, count: 10, moduleName, onAttempt });

    await record('ground', `${recapReport.kept} points kept, ${recapReport.dropped} dropped; ${quizReport.kept} questions kept, ${quizReport.removed} removed`);

    // Chunk-id citations already passed grounding above. This step is purely
    // about identity: which source and page each surviving citation actually
    // points at, plus the per-source citation-count summary the recap shows.
    const { recap: attributedRecap, quiz: attributedQuiz, sourcesSummary } = resolveRecapCitations({
      recap,
      quiz,
      chunks,
      refMap,
    });

    await record('store', 'Saving your recap');
    const now = new Date().toISOString();
    await updateItem(keys.binder(userId, binderId), {
      recap: attributedRecap,
      quiz: attributedQuiz,
      chunks,
      sourcesSummary,
      generatedAt: now,
      updatedAt: now,
      sourcesCovered: ready.map((s) => s.id),
      provider: {
        name: recapMeta.provider,
        model: recapMeta.model,
        latencyMs: recapMeta.latencyMs + quizMeta.latencyMs,
        tokensIn: recapMeta.tokensIn + quizMeta.tokensIn,
        tokensOut: recapMeta.tokensOut + quizMeta.tokensOut,
        costUsd: recapMeta.costUsd + quizMeta.costUsd,
      },
    });

    await updateItem(keys.job(jobId), { status: 'ready', stage: 'done', progress: 100, log });
  } catch (e) {
    await fail(e?.message ?? 'Generation failed unexpectedly.');
  }
}
