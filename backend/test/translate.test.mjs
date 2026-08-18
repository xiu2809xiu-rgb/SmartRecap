import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateStudyPack } from '../src/ai/generate.js';
import { normaliseLanguage, languageName, LANGUAGES } from '../src/ai/languages.js';
import { QUIZ_DIFFICULTIES, quizPrompt } from '../src/ai/prompts.js';

/**
 * Translation and the study options the student chooses.
 *
 *   node --test test/
 *
 * The thing worth guarding here is not the wording of a translation — no test
 * can judge that — it is that translating a study pack moves TEXT and nothing
 * else. Citations, chunk ids, answer indices and `verified` flags are what make
 * a recap checkable, and a translation pass that quietly renumbers an answer or
 * drops a citation would break the product's only real claim while looking
 * completely fine on screen.
 *
 * `translateStudyPack` calls a model, so these tests stub the provider by
 * intercepting the module's HTTP layer through an injected fetch. No network,
 * no API key, no cost — same as every other test here.
 */

/* -------------------------------------------------------------- fixtures */

const pack = () => ({
  recap: {
    summary: 'A summary sentence.',
    readMinutes: 4,
    sections: [
      {
        id: 's1',
        heading: 'Normalisation',
        points: [
          { id: 'p1', text: 'Third normal form removes transitive dependencies.', citations: ['c3'], confidence: 'grounded' },
          { id: 'p2', text: 'A primary key uniquely identifies a row.', citations: ['c1', 'c2'], confidence: 'inferred' },
        ],
      },
    ],
    keyTerms: [{ term: 'Primary key', definition: 'The column that identifies a row.', citations: ['c1'] }],
    examTips: ['Know the three normal forms in order.'],
    ungrounded: [{ text: 'Something unsupported.', reason: 'Nothing in the material settles it.' }],
  },
  quiz: {
    questions: [
      {
        id: 'q1',
        type: 'single',
        topic: 'Keys',
        difficulty: 2,
        prompt: 'What does a primary key do?',
        options: ['Sorts rows', 'Identifies a row', 'Encrypts a row', 'Deletes a row'],
        answer: 1,
        explanation: 'It uniquely identifies a row.',
        citations: ['c1'],
        verified: true,
      },
      {
        id: 'q2',
        type: 'short',
        topic: 'Normalisation',
        difficulty: 3,
        prompt: 'Explain third normal form.',
        modelAnswer: 'It removes transitive dependencies.',
        rubric: 'Must mention transitive dependency.',
        explanation: 'That is the defining property.',
        citations: ['c3'],
        verified: false,
      },
    ],
  },
});

/** `provider.js` reads the body with `res.text()`, so a bare object will not do. */
const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(payload),
});

/**
 * Stands in for the model: echoes every string back with a marker, so a
 * translated field is identifiable and an untranslated one is obvious.
 */
function stubProvider(transform = (s) => `«${s}»`) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const sent = body.messages.at(-1).content;
    const input = JSON.parse(sent.slice(sent.indexOf('{', sent.indexOf('INPUT:'))));
    const out = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, transform(v)]));
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify(out) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const withProviderEnv = (fn) => async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  }
};

/* ---------------------------------------------------------------- tests */

test('English is not a translation, so nothing is called', async () => {
  const stub = stubProvider();
  try {
    const input = pack();
    const out = await translateStudyPack({ ...input, language: 'en' });
    assert.equal(out.translated, false);
    assert.equal(stub.calls.length, 0);
    assert.equal(out.recap, input.recap, 'the original object should be handed straight back');
  } finally {
    stub.restore();
  }
});

test(
  'translating moves text and leaves citations, indices and flags untouched',
  withProviderEnv(async () => {
    const stub = stubProvider();
    try {
      const input = pack();
      const out = await translateStudyPack({ ...input, language: 'zh' });

      assert.equal(out.translated, true);

      const point = out.recap.sections[0].points[0];
      assert.equal(point.text, '«Third normal form removes transitive dependencies.»');
      assert.deepEqual(point.citations, ['c3'], 'citations must survive verbatim');
      assert.equal(point.confidence, 'grounded');
      assert.deepEqual(out.recap.sections[0].points[1].citations, ['c1', 'c2']);

      const single = out.quiz.questions[0];
      assert.equal(single.answer, 1, 'the answer index must not move');
      assert.equal(single.options.length, 4);
      assert.equal(single.options[1], '«Identifies a row»');
      assert.equal(single.verified, true);
      assert.deepEqual(single.citations, ['c1']);
      assert.equal(single.id, 'q1');
      assert.equal(single.type, 'single');

      const short = out.quiz.questions[1];
      assert.equal(short.modelAnswer, '«It removes transitive dependencies.»');
      assert.equal(short.rubric, '«Must mention transitive dependency.»');
      assert.equal(short.verified, false, 'an unverified question must stay unverified');
      assert.equal(short.difficulty, 3);
    } finally {
      stub.restore();
    }
  }),
);

test(
  'a key term keeps its name and translates only the definition',
  withProviderEnv(async () => {
    const stub = stubProvider();
    try {
      const out = await translateStudyPack({ ...pack(), language: 'ms' });
      const term = out.recap.keyTerms[0];
      // The exam paper will say "Primary key". Replacing it would cost the
      // student the one word they most need to recognise.
      assert.equal(term.term, 'Primary key');
      assert.equal(term.definition, '«The column that identifies a row.»');
    } finally {
      stub.restore();
    }
  }),
);

test(
  'the original pack is never mutated',
  withProviderEnv(async () => {
    const stub = stubProvider();
    try {
      const input = pack();
      const before = JSON.stringify(input);
      await translateStudyPack({ ...input, language: 'ta' });
      assert.equal(JSON.stringify(input), before);
    } finally {
      stub.restore();
    }
  }),
);

test(
  'a failed translation keeps the original wording instead of failing the job',
  withProviderEnv(async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    try {
      const out = await translateStudyPack({ ...pack(), language: 'zh' });
      assert.equal(out.translated, false);
      assert.equal(out.recap.sections[0].points[0].text, 'Third normal form removes transitive dependencies.');
      assert.deepEqual(out.recap.sections[0].points[0].citations, ['c3']);
    } finally {
      globalThis.fetch = original;
    }
  }),
);

test(
  'a partial response translates what came back and leaves the rest alone',
  withProviderEnv(async () => {
    const original = globalThis.fetch;
    // Only the first key returns. Everything else must survive as-is.
    globalThis.fetch = async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ t0: 'translated summary' }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    try {
      const out = await translateStudyPack({ ...pack(), language: 'zh' });
      assert.equal(out.recap.summary, 'translated summary');
      assert.equal(out.recap.sections[0].heading, 'Normalisation');
      assert.equal(out.quiz.questions[0].answer, 1);
    } finally {
      globalThis.fetch = original;
    }
  }),
);

test('an unknown language falls back to English rather than throwing', () => {
  assert.equal(normaliseLanguage('klingon'), 'en');
  assert.equal(normaliseLanguage(undefined), 'en');
  assert.equal(normaliseLanguage('zh'), 'zh');
  assert.equal(languageName('ta'), 'Tamil');
  assert.equal(LANGUAGES[0].code, 'en');
});

test('every difficulty produces a distinct brief the model can act on', () => {
  assert.deepEqual(QUIZ_DIFFICULTIES, ['gentle', 'balanced', 'challenge']);

  const briefOf = (difficulty) =>
    quizPrompt({ chunks: [{ id: 'c1', label: 'Slide 1', text: 'x' }], count: 3, difficulty }).at(-1).content;

  const gentle = briefOf('gentle');
  const challenge = briefOf('challenge');
  assert.match(gentle, /GENTLE/);
  assert.match(challenge, /CHALLENGE/);
  assert.notEqual(gentle, challenge);

  // An unrecognised value must not silently drop the brief altogether.
  assert.match(briefOf('impossible'), /BALANCED/);
  assert.match(briefOf(undefined), /BALANCED/);

  // Difficulty must never be allowed to buy itself out of grounding.
  for (const level of QUIZ_DIFFICULTIES) {
    assert.match(briefOf(level), /Citation rules, which override every other instruction/);
  }
});
