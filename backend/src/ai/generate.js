import { complete } from './provider.js';
import { recapPrompt, quizPrompt, askPrompt, judgeShortAnswerPrompt, repairPrompt, translatePrompt } from './prompts.js';
import { languageName, normaliseLanguage } from './languages.js';
import { groundRecap, groundQuiz, groundAnswer } from './ground.js';
import { upstream } from '../lib/http.js';

/**
 * Turning a model response into a validated object.
 *
 * Free-tier models are inconsistent about structured output: some honour
 * `response_format: json_schema`, some ignore it, and several wrap perfectly
 * good JSON in a markdown fence or a sentence of preamble. So parsing is
 * deliberately forgiving about the envelope and completely unforgiving about
 * the contents.
 */

function extractJson(text) {
  const trimmed = String(text).trim();

  // Fast path: it is already JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the tolerant paths */
  }

  // A fenced block, with or without a language tag.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep going */
    }
  }

  // Preamble before the object: take from the first brace to the last.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* give up */
    }
  }

  return null;
}

/* ------------------------------------------------------------- validation */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function validateRecap(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['Response was not a JSON object.'];
  if (!isNonEmptyString(obj.summary)) errors.push('"summary" must be a non-empty string.');
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    errors.push('"sections" must be a non-empty array.');
  } else {
    obj.sections.forEach((s, i) => {
      if (!isNonEmptyString(s?.heading)) errors.push(`sections[${i}].heading must be a non-empty string.`);
      if (!Array.isArray(s?.points) || s.points.length === 0) {
        errors.push(`sections[${i}].points must be a non-empty array.`);
      } else {
        s.points.forEach((p, j) => {
          if (!isNonEmptyString(p?.text)) errors.push(`sections[${i}].points[${j}].text must be a non-empty string.`);
          if (!Array.isArray(p?.citations)) errors.push(`sections[${i}].points[${j}].citations must be an array.`);
        });
      }
    });
  }
  if (obj.keyTerms && !Array.isArray(obj.keyTerms)) errors.push('"keyTerms" must be an array when present.');
  if (obj.examTips && !Array.isArray(obj.examTips)) errors.push('"examTips" must be an array when present.');
  return errors;
}

function validateQuiz(obj) {
  if (!obj || typeof obj !== 'object') return ['Response was not a JSON object.'];
  if (!Array.isArray(obj.questions) || obj.questions.length === 0) return ['"questions" must be a non-empty array.'];
  const errors = [];
  const ids = new Set();
  obj.questions.forEach((q, i) => {
    const type = q?.type ?? 'single';
    if (!isNonEmptyString(q?.id)) {
      errors.push(`questions[${i}].id must be a non-empty string.`);
    } else if (ids.has(q.id)) {
      errors.push(`questions[${i}].id must be unique.`);
    } else {
      ids.add(q.id);
    }
    if (!['single', 'multi', 'short'].includes(type)) {
      errors.push(`questions[${i}].type must be "single", "multi" or "short".`);
    }
    if (!isNonEmptyString(q?.prompt)) errors.push(`questions[${i}].prompt must be a non-empty string.`);
    if (!Array.isArray(q?.citations)) errors.push(`questions[${i}].citations must be an array.`);

    if (type === 'short') {
      if (q.options != null) errors.push(`questions[${i}].options must be omitted for short questions.`);
      if (!isNonEmptyString(q?.modelAnswer)) errors.push(`questions[${i}].modelAnswer must be a non-empty string.`);
      if (!isNonEmptyString(q?.rubric)) errors.push(`questions[${i}].rubric must be a non-empty string.`);
      return;
    }

    if (!Array.isArray(q?.options) || q.options.length !== 4) {
      errors.push(`questions[${i}].options must have exactly 4 entries.`);
      return;
    }

    if (type === 'multi') {
      const answer = q?.answer;
      const unique = Array.isArray(answer) ? new Set(answer) : new Set();
      if (
        !Array.isArray(answer) ||
        answer.length < 2 ||
        answer.length >= q.options.length ||
        unique.size !== answer.length ||
        answer.some((index) => !Number.isInteger(index) || index < 0 || index >= q.options.length)
      ) {
        errors.push(`questions[${i}].answer must contain 2 or 3 unique valid option indices.`);
      }
    } else if (!Number.isInteger(q?.answer) || q.answer < 0 || q.answer >= q.options.length) {
      errors.push(`questions[${i}].answer must be a valid integer index.`);
    }
  });
  return errors;
}

function validateShortAnswerJudgement(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return ['Response was not a JSON object.'];
  if (typeof obj.correct !== 'boolean') errors.push('"correct" must be a boolean.');
  if (!isNonEmptyString(obj.feedback)) errors.push('"feedback" must be a non-empty string.');
  return errors;
}

/**
 * One generation attempt, then at most one repair round.
 *
 * The repair prompt carries only the errors and the bad output, not the source
 * material again — a schema slip is a formatting problem, and resending 6,000
 * tokens of chunks to fix a missing bracket is how a free tier gets burned.
 */
async function generateValidated({ messages, validate, onAttempt, maxTokens, temperature }) {
  const first = await complete({ messages, maxTokens, temperature }, { onAttempt });
  const parsed = extractJson(first.content);
  const errors = parsed ? validate(parsed) : ['Response could not be parsed as JSON.'];

  if (!errors.length) return { data: parsed, meta: first, repaired: false };

  onAttempt?.({ status: 'repairing', reason: errors[0] });

  const second = await complete(
    { messages: repairPrompt({ badOutput: first.content, errors }), maxTokens, temperature: 0 },
    { onAttempt },
  );
  const reparsed = extractJson(second.content);
  const stillWrong = reparsed ? validate(reparsed) : ['Repair response could not be parsed as JSON.'];

  if (stillWrong.length) {
    throw upstream('The model could not produce a valid recap for this material.', stillWrong.slice(0, 5));
  }

  return {
    data: reparsed,
    meta: {
      ...second,
      // Bill the caller for both round trips — the transparency panel should
      // show what the recap actually cost, not just the successful call.
      tokensIn: first.tokensIn + second.tokensIn,
      tokensOut: first.tokensOut + second.tokensOut,
      latencyMs: first.latencyMs + second.latencyMs,
    },
    repaired: true,
  };
}

/* -------------------------------------------------------------- entry points */

export async function generateRecap({ chunks, mode, moduleName, onAttempt }) {
  const { data, meta, repaired } = await generateValidated({
    messages: recapPrompt({ chunks, mode, moduleName }),
    validate: validateRecap,
    maxTokens: 4096,
    temperature: 0.25,
    onAttempt,
  });
  const { recap, report } = groundRecap(data, chunks);
  if (!recap.sections.length) {
    throw upstream('Nothing in the recap could be traced back to your material, so there was nothing safe to show.');
  }
  return { recap, meta, report: { ...report, repaired } };
}

export async function generateQuiz({ chunks, count, moduleName, difficulty, onAttempt }) {
  const { data, meta, repaired } = await generateValidated({
    messages: quizPrompt({ chunks, count, moduleName, difficulty }),
    validate: validateQuiz,
    maxTokens: 4096,
    temperature: 0.35,
    onAttempt,
  });
  const { quiz, report } = groundQuiz(data, chunks);
  return { quiz, meta, report: { ...report, repaired } };
}

/* ------------------------------------------------------------- translation */

/**
 * Every translatable string in a study pack, each paired with a setter that
 * writes the translation back where it came from.
 *
 * Collecting setters rather than paths means the shape is never re-walked and
 * never parsed, so a translation cannot land in the wrong field. Citations,
 * chunk ids, answer indices and `verified` flags are not in this list at all —
 * they are structure, and translating structure is how you break it.
 */
function translatableFields(recap, quiz) {
  const out = [];
  const push = (text, set) => {
    if (typeof text === 'string' && text.trim()) out.push({ text, set });
  };

  push(recap.summary, (v) => {
    recap.summary = v;
  });
  for (const section of recap.sections ?? []) {
    push(section.heading, (v) => {
      section.heading = v;
    });
    for (const point of section.points ?? []) {
      push(point.text, (v) => {
        point.text = v;
      });
    }
  }
  // The term itself stays in the material's language on purpose: it is the
  // word the exam paper will use, so replacing it would cost the student the
  // one thing they most need to recognise. Only the explanation moves.
  for (const term of recap.keyTerms ?? []) {
    push(term.definition, (v) => {
      term.definition = v;
    });
  }
  (recap.examTips ?? []).forEach((tip, i) => {
    push(tip, (v) => {
      recap.examTips[i] = v;
    });
  });
  for (const item of recap.ungrounded ?? []) {
    push(item.text, (v) => {
      item.text = v;
    });
    push(item.reason, (v) => {
      item.reason = v;
    });
  }

  for (const question of quiz?.questions ?? []) {
    push(question.prompt, (v) => {
      question.prompt = v;
    });
    push(question.explanation, (v) => {
      question.explanation = v;
    });
    push(question.modelAnswer, (v) => {
      question.modelAnswer = v;
    });
    push(question.rubric, (v) => {
      question.rubric = v;
    });
    (question.options ?? []).forEach((option, i) => {
      push(option, (v) => {
        question.options[i] = v;
      });
    });
  }

  return out;
}

// Small enough that a batch fits comfortably inside 4096 output tokens even in
// a script that expands under translation, large enough that a 15-question pack
// is three calls rather than thirty.
const BATCH = 50;

/**
 * Translates a grounded study pack in place-ish (on a clone) into `language`.
 *
 * A translation failure never fails the job. Anything that does not come back
 * keeps its original wording, so the worst case is a recap that is partly in
 * English — which is still a usable recap, and is visibly what happened rather
 * than a blank screen twenty seconds before a demo.
 */
export async function translateStudyPack({ recap, quiz, language, onAttempt }) {
  const code = normaliseLanguage(language);
  if (code === 'en') return { recap, quiz, translated: false, language: code };

  const nextRecap = structuredClone(recap);
  const nextQuiz = structuredClone(quiz);
  const fields = translatableFields(nextRecap, nextQuiz);
  if (!fields.length) return { recap, quiz, translated: false, language: code };

  const name = languageName(code);
  const meta = { tokensIn: 0, tokensOut: 0, latencyMs: 0, costUsd: 0 };
  let applied = 0;

  for (let start = 0; start < fields.length; start += BATCH) {
    const batch = fields.slice(start, start + BATCH);
    const items = Object.fromEntries(batch.map((f, i) => [`t${i}`, f.text]));

    try {
      const res = await complete(
        { messages: translatePrompt({ language: name, items }), maxTokens: 4096, temperature: 0.1 },
        { onAttempt },
      );
      meta.tokensIn += res.tokensIn ?? 0;
      meta.tokensOut += res.tokensOut ?? 0;
      meta.latencyMs += res.latencyMs ?? 0;
      meta.costUsd += res.costUsd ?? 0;

      const parsed = extractJson(res.content);
      if (!parsed || typeof parsed !== 'object') {
        onAttempt?.({ status: 'failed', provider: 'translation', reason: 'Unreadable response — this batch stays in the original language.' });
        continue;
      }

      batch.forEach((field, i) => {
        const value = parsed[`t${i}`];
        if (typeof value === 'string' && value.trim()) {
          field.set(value.trim());
          applied += 1;
        }
      });
    } catch (e) {
      onAttempt?.({ status: 'failed', provider: 'translation', reason: e?.message ?? 'Translation call failed.' });
    }
  }

  return {
    recap: nextRecap,
    quiz: nextQuiz,
    language: code,
    translated: applied > 0,
    meta,
    report: { total: fields.length, applied },
  };
}

export async function judgeShortAnswer({ prompt, modelAnswer, rubric, studentAnswer, onAttempt }) {
  const { data } = await generateValidated({
    messages: judgeShortAnswerPrompt({ prompt, modelAnswer, rubric, studentAnswer }),
    validate: validateShortAnswerJudgement,
    maxTokens: 450,
    temperature: 0,
    onAttempt,
  });
  return { correct: data.correct, feedback: data.feedback.trim() };
}

export async function answerQuestion({ chunks, question, history }) {
  const res = await complete(
    { messages: askPrompt({ chunks, question, history }), maxTokens: 900, temperature: 0.2 },
    {},
  );
  const parsed = extractJson(res.content);
  if (!parsed) {
    return { answer: 'The model returned something unreadable. Try asking again.', citations: [], grounded: false };
  }
  return { ...groundAnswer(parsed, chunks), provider: res.provider, model: res.model };
}
