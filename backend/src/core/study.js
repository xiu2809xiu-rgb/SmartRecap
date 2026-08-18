import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { keys, newId, putItem, queryPrefix } from '../lib/db.js';
import { putObject, presignDownload, audioKey } from '../lib/s3.js';
import { badRequest } from '../lib/http.js';
import { loadMaterial } from './library.js';
import { answerQuestion } from '../ai/generate.js';

/**
 * Quiz attempts, grounded Q&A and read-aloud.
 * Plain functions — see the note at the top of `core/auth.js`.
 */

const polly = new PollyClient({});

/**
 * Only `verified` questions count toward the score. A question the source
 * material does not settle is still shown and still explained, but scoring it
 * would measure whether the student guessed the model rather than whether they
 * learned the deck.
 */
export async function submitAttempt(userId, { materialId, answers, durationMs }) {
  if (!materialId || !answers) throw badRequest('materialId and answers are required.');
  const material = await loadMaterial(userId, materialId);

  const questions = material.quiz?.questions ?? [];
  const scored = questions.filter((q) => q.verified);
  const correct = scored.filter((q) => answers[q.id] === q.answer).length;

  const byTopic = Object.entries(
    scored.reduce((acc, q) => {
      acc[q.topic] ??= { correct: 0, total: 0 };
      acc[q.topic].total += 1;
      if (answers[q.id] === q.answer) acc[q.topic].correct += 1;
      return acc;
    }, {}),
  ).map(([topic, v]) => ({ topic, ...v }));

  const at = new Date().toISOString();
  const attempt = {
    id: newId('a'),
    materialId,
    at,
    durationMs: Number(durationMs) || 0,
    correct,
    total: scored.length,
    score: scored.length ? Math.round((correct / scored.length) * 100) : 0,
    byTopic,
    answers,
  };

  await putItem({ ...keys.attempt(userId, at, attempt.id), ...attempt });
  return attempt;
}

export async function listAttempts(userId, materialId) {
  const items = await queryPrefix(keys.attemptPrefix(userId));
  return items
    .map(({ pk, sk, ...rest }) => rest)
    .filter((a) => !materialId || a.materialId === materialId)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

export async function ask(userId, { materialId, question, history }) {
  if (!materialId || !question) throw badRequest('materialId and question are required.');
  const material = await loadMaterial(userId, materialId);
  if (!material.chunks?.length) throw badRequest('That material has no extracted text to search.');
  return answerQuestion({ chunks: material.chunks, question: String(question).slice(0, 500), history: history ?? [] });
}

/** Read-aloud via Amazon Polly, for revising away from a screen. */
export async function textToSpeech(userId, { materialId }) {
  if (!materialId) throw badRequest('materialId is required.');
  const material = await loadMaterial(userId, materialId);
  const recap = material.recap;
  if (!recap) throw badRequest('That material has no recap to read.');

  const script = [recap.summary, ...recap.sections.flatMap((s) => [`${s.heading}.`, ...s.points.map((p) => p.text)])]
    .join(' ')
    // Polly caps a single synthesis request at 3,000 characters.
    .slice(0, 2900);

  const res = await polly.send(
    new SynthesizeSpeechCommand({ Text: script, OutputFormat: 'mp3', VoiceId: 'Amy', Engine: 'neural' }),
  );
  const key = audioKey(userId, materialId);
  await putObject(key, Buffer.from(await res.AudioStream.transformToByteArray()), 'audio/mpeg');
  return { url: await presignDownload(key, 3600), characters: script.length };
}
