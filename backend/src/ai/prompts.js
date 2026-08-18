/**
 * Prompts.
 *
 * The whole product claim rests on these, so two things are non-negotiable in
 * every one of them:
 *
 *  1. The model only ever sees numbered chunks, and is told that a claim
 *     without a chunk id is worthless. Asking for citations after the fact does
 *     not work — the model has to be writing against the ids as it goes.
 *  2. "Not in the material" is an allowed and expected answer. Most
 *     hallucination in study tools comes from a prompt that implicitly demands
 *     N bullet points whether or not the source supports N.
 *
 * Nothing here is enforcement. `ground.js` does the enforcement; the prompt
 * just makes compliance the path of least resistance.
 */

export const renderChunks = (chunks) =>
  chunks.map((c) => `[${c.id}] (${c.label})\n${c.text}`).join('\n\n');

const CITATION_RULES = `
Citation rules, which override every other instruction:
- Every point, key term and quiz question MUST carry a "citations" array of chunk ids taken verbatim from the material below (for example ["c3"] or ["c3","c7"]).
- Only cite a chunk that actually states the thing you are claiming. Do not cite a chunk because it is nearby or on a related topic.
- If you cannot support a statement from the chunks, do not write it. Put it in "ungrounded" instead, with a one-sentence reason.
- Never invent a chunk id. Ids that do not appear below will be discarded and the point deleted.
- Write in British English. Do not use the words "delve", "moreover" or "furthermore".
`.trim();

export function recapPrompt({ chunks, mode, moduleName }) {
  const depth =
    mode === 'cram'
      ? `Depth: LAST-MINUTE CRAM. The reader has under fifteen minutes before an exam. Give 3 to 4 sections of 2 to 3 points each. Every point must be something that could be asked about. Cut worked reasoning, history and asides.`
      : `Depth: DEEP REVISION. The reader is learning this properly. Give 4 to 6 sections of 3 to 4 points each. Keep definitions precise, keep the worked reasoning, and keep edge cases where the material states them.`;

  return [
    {
      role: 'system',
      content: `You produce revision recaps for students from their own lecture material. You are accurate before you are helpful: a recap the student cannot trust is worse than no recap. You reply with JSON only, no prose around it, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Write a structured recap of the material below${moduleName ? ` for the module "${moduleName}"` : ''}.

${depth}

${CITATION_RULES}

Return exactly this JSON shape:
{
  "summary": "2-4 sentences covering what the whole deck is about and what it wants the student to be able to do.",
  "readMinutes": 5,
  "sections": [
    {
      "id": "s1",
      "heading": "Short heading in the material's own vocabulary",
      "points": [
        { "id": "p1", "text": "One self-contained sentence a student could revise from.", "citations": ["c1"] }
      ]
    }
  ],
  "keyTerms": [
    { "term": "Term as the material names it", "definition": "One sentence.", "citations": ["c3"] }
  ],
  "examTips": [
    "Concrete advice tied to what this material emphasises. Only include tips the material supports."
  ],
  "ungrounded": [
    { "text": "Something you wanted to say but could not support.", "reason": "Why the material does not settle it." }
  ]
}

Use sequential ids: sections s1, s2, ...; points p1, p2, ... continuing across sections. Set "readMinutes" to an honest estimate of how long the recap itself takes to read.

Return "ungrounded": [] if everything you wrote is supported. Do not pad it.

MATERIAL:

${renderChunks(chunks)}`,
    },
  ];
}

export function quizPrompt({ chunks, count, moduleName }) {
  return [
    {
      role: 'system',
      content: `You write multiple-choice revision questions from a student's own lecture material. A question whose answer is not settled by the material is worse than no question, so you mark those honestly instead of hiding them. You reply with JSON only, no prose around it, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Write ${count} multiple-choice questions on the material below${moduleName ? ` for the module "${moduleName}"` : ''}.

${CITATION_RULES}

Question rules:
- Exactly four options each. One is correct; the other three must be plausible to someone who half-read the material, not obviously silly.
- "answer" is the zero-based index of the correct option.
- Spread across difficulty: 1 = recall a stated fact, 2 = apply it, 3 = reason across two parts of the material.
- Spread across topics. Do not write four questions on one slide.
- Set "verified": true only when the cited chunks settle the answer beyond argument. If the answer depends on outside knowledge, on your judgement, or on a claim the material only implies, set "verified": false. Questions marked false are shown to the student but excluded from their score, so marking one false is never a failure — writing a confident wrong question is.
- "explanation" says why the correct option is correct, in one or two sentences, using the material's own vocabulary.

Return exactly this JSON shape:
{
  "questions": [
    {
      "id": "q1",
      "topic": "Short topic label, reused across questions on the same topic",
      "difficulty": 1,
      "prompt": "The question.",
      "options": ["A", "B", "C", "D"],
      "answer": 1,
      "explanation": "Why B is right.",
      "citations": ["c4"],
      "verified": true
    }
  ]
}

MATERIAL:

${renderChunks(chunks)}`,
    },
  ];
}

export function askPrompt({ chunks, question, history = [] }) {
  return [
    {
      role: 'system',
      content: `You answer a student's questions using ONLY the lecture material they uploaded. If the material does not answer the question, you say so plainly and do not fill the gap from general knowledge — the student needs to know what their own deck does and does not cover. You reply with JSON only, no prose around it, no markdown fences.`,
    },
    ...history.slice(-4).map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `Question: ${question}

${CITATION_RULES}

Return exactly this JSON shape:
{
  "answer": "Your answer, in 1-4 sentences, in the material's own vocabulary.",
  "citations": ["c2"],
  "grounded": true
}

If the material does not cover the question, return "grounded": false, an empty "citations" array, and an "answer" that says which topics the material does cover instead. Never answer from outside the material while claiming it is grounded.

MATERIAL:

${renderChunks(chunks)}`,
    },
  ];
}

/**
 * Sent back when the first response fails schema validation. Repeating the
 * whole material would double token spend for what is almost always a
 * formatting slip, so this only carries the errors and the bad output.
 */
export function repairPrompt({ badOutput, errors }) {
  return [
    {
      role: 'system',
      content: 'You fix malformed JSON. You return only the corrected JSON object, with no prose and no markdown fences.',
    },
    {
      role: 'user',
      content: `This JSON failed validation:

${errors.map((e) => `- ${e}`).join('\n')}

Return the same content with those problems fixed. Change nothing else — do not reword the material, do not add or remove points, and do not invent citations.

${badOutput.slice(0, 12_000)}`,
    },
  ];
}
