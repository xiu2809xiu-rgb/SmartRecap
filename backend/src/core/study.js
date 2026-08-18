import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { keys, newId, putItem, queryPrefix } from '../lib/db.js';
import { putObject, presignDownload, audioKey } from '../lib/s3.js';
import { badRequest } from '../lib/http.js';
import { loadMaterial } from './library.js';
import { answerQuestion, judgeShortAnswer } from '../ai/generate.js';

/**
 * Quiz attempts, grounded Q&A and read-aloud.
 * Plain functions — see the note at the top of `core/auth.js`.
 */

const polly = new PollyClient({});

const questionType = (question) => question?.type ?? 'single';

function exactSetMatch(submitted, expected) {
  if (!Array.isArray(submitted) || !Array.isArray(expected)) return false;
  const submittedSet = new Set(submitted);
  const expectedSet = new Set(expected);
  return submittedSet.size === submitted.length && submittedSet.size === expectedSet.size && [...expectedSet].every((v) => submittedSet.has(v));
}

function objectiveAnswerIsCorrect(question, answer) {
  if (questionType(question) === 'multi') return exactSetMatch(answer, question.answer);
  // Deliberately preserve the legacy single-select strict comparison.
  return answer === question.answer;
}

/**
 * Only `verified` questions count toward the score. A question the source
 * material does not settle is still shown and still explained, but scoring it
 * would measure whether the student guessed the model rather than whether they
 * learned the deck. Short-answer judge failures are represented as unverified
 * judgements and excluded from the denominator without failing the attempt.
 */
export async function submitAttempt(userId, { materialId, answers, durationMs, questionIds }) {
  if (!materialId || !answers) throw badRequest('materialId and answers are required.');
  const material = await loadMaterial(userId, materialId);

  const allQuestions = material.quiz?.questions ?? [];
  if (Array.isArray(questionIds)) {
    if (!questionIds.length) throw badRequest('questionIds must contain at least one question.');
    const knownIds = new Set(allQuestions.map((q) => q.id));
    if (questionIds.some((id) => !knownIds.has(id))) throw badRequest('questionIds contains a question not in this material.');
  }
  const requestedIds = Array.isArray(questionIds) ? new Set(questionIds) : null;
  const questions = allQuestions.filter((q) => !requestedIds || requestedIds.has(q.id));
  const verifiedQuestions = questions.filter((q) => q.verified);

  const judgementEntries = await Promise.all(
    verifiedQuestions
      .filter((q) => questionType(q) === 'short')
      .map(async (q) => {
        try {
          const result = await judgeShortAnswer({
            prompt: q.prompt,
            modelAnswer: q.modelAnswer,
            rubric: q.rubric,
            studentAnswer: String(answers[q.id] ?? '').slice(0, 2_000),
          });
          return [
            q.id,
            { correct: result.correct, feedback: result.feedback, gradedBy: 'ai-judge', verified: true },
          ];
        } catch {
          return [
            q.id,
            {
              correct: null,
              feedback: 'This answer could not be judged, so it was excluded from your score.',
              gradedBy: 'ai-judge',
              verified: false,
            },
          ];
        }
      }),
  );
  const judgements = Object.fromEntries(judgementEntries);

  const scored = verifiedQuestions.filter(
    (q) => questionType(q) !== 'short' || judgements[q.id]?.verified === true,
  );
  const isCorrect = (q) =>
    questionType(q) === 'short' ? judgements[q.id]?.correct === true : objectiveAnswerIsCorrect(q, answers[q.id]);
  const correct = scored.filter(isCorrect).length;

  const byTopic = Object.entries(
    scored.reduce((acc, q) => {
      acc[q.topic] ??= { correct: 0, total: 0 };
      acc[q.topic].total += 1;
      if (isCorrect(q)) acc[q.topic].correct += 1;
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
    judgements,
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
