/**
 * The grounding pass.
 *
 * Prompts ask for citations. This is what makes them mean something.
 *
 * Two checks run against every claim the model produced:
 *
 *   1. Resolution — does each cited id exist in the chunk set we actually sent?
 *      Models invent ids, especially near the end of a long generation. A claim
 *      left with no resolvable citation is removed from the recap.
 *
 *   2. Overlap — does the claim share meaningful vocabulary with the chunk it
 *      cites? This is the check that catches the more dangerous failure: a true
 *      statement attached to the wrong slide, which resolution alone waves
 *      through. It is a lexical heuristic, not semantic comparison, so the
 *      threshold is set low — its job is to catch a claim citing a chunk about
 *      an unrelated topic, not to referee close paraphrase.
 *
 * Everything dropped is kept, with a reason, and surfaced in the reader. A
 * student learns more from seeing what the model wanted to claim and could not
 * support than from a recap that is quietly shorter than it should be.
 */

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
   can cannot could did do does doing down during each few for from further had has have having he her here hers herself
   him himself his how i if in into is it its itself me more most my myself no nor not of off on once only or other ought
   our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
   these they this those through to too under until up very was we were what when where which while who whom why will
   with would you your yours yourself yourselves it's don't doesn't isn't aren't wasn't weren't`
    .split(/\s+/)
    .filter(Boolean),
);

/** Content words only, lowercased, with a crude plural/tense trim. */
function contentTokens(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => w.replace(/(ies)$/, 'y').replace(/(ses|es|s)$/, (m, g) => (g === 'ses' ? 's' : ''))),
  );
}

/** Share of the claim's content words that appear in the cited text. */
function overlapRatio(claim, source) {
  const a = contentTokens(claim);
  if (a.size === 0) return 1;
  const b = contentTokens(source);
  let hits = 0;
  for (const w of a) if (b.has(w)) hits += 1;
  return hits / a.size;
}

// Below this, the claim and its cited chunk are almost certainly about
// different things. Paraphrase routinely lands around 0.35-0.6, so 0.18 only
// fires on a genuine mismatch.
const MIN_OVERLAP = 0.18;

function checkCitations(text, citations, chunkById) {
  const resolved = (citations ?? []).filter((id) => chunkById.has(id));
  if (!resolved.length) {
    return {
      ok: false,
      resolved: [],
      reason:
        (citations ?? []).length > 0
          ? `Cited ${citations.join(', ')}, but no chunk with that id was sent to the model.`
          : 'The model gave no citation for this, so there is nothing in your upload backing it.',
    };
  }

  const best = Math.max(...resolved.map((id) => overlapRatio(text, chunkById.get(id).text)));
  if (best < MIN_OVERLAP) {
    const labels = resolved.map((id) => chunkById.get(id).label).join(', ');
    return {
      ok: false,
      resolved,
      reason: `Cited ${labels}, but that passage does not discuss this — the citation does not hold up.`,
    };
  }

  return { ok: true, resolved, confidence: best >= 0.45 ? 'grounded' : 'inferred' };
}

/**
 * Filters a recap down to what the source actually supports.
 * Returns the cleaned recap plus a report the pipeline log can print.
 */
export function groundRecap(recap, chunks) {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const ungrounded = [...(recap.ungrounded ?? [])];
  let kept = 0;
  let dropped = 0;

  const sections = (recap.sections ?? [])
    .map((section) => {
      const points = [];
      for (const point of section.points ?? []) {
        if (!point?.text) continue;
        const check = checkCitations(point.text, point.citations, chunkById);
        if (check.ok) {
          points.push({ ...point, citations: check.resolved, confidence: check.confidence });
          kept += 1;
        } else {
          ungrounded.push({ text: point.text, reason: check.reason });
          dropped += 1;
        }
      }
      return { ...section, points };
    })
    // A section whose every point failed is an empty heading; drop it too.
    .filter((s) => s.points.length > 0);

  const keyTerms = (recap.keyTerms ?? []).filter((t) => {
    if (!t?.term || !t?.definition) return false;
    const check = checkCitations(`${t.term} ${t.definition}`, t.citations, chunkById);
    if (check.ok) {
      t.citations = check.resolved;
      return true;
    }
    ungrounded.push({ text: `${t.term}: ${t.definition}`, reason: check.reason });
    dropped += 1;
    return false;
  });

  return {
    recap: {
      summary: recap.summary ?? '',
      readMinutes: Number(recap.readMinutes) || Math.max(1, Math.round(kept * 0.4)),
      sections,
      keyTerms,
      examTips: (recap.examTips ?? []).filter((t) => typeof t === 'string' && t.trim()),
      ungrounded,
    },
    report: { kept, dropped, sections: sections.length },
  };
}

/**
 * Quiz grounding. A question that cannot be traced is removed outright — an
 * unanswerable question wastes the student's time even unscored. A question
 * that resolves but reads as weakly supported is kept with `verified: false`,
 * so it still teaches without counting against the score.
 */
export function groundQuiz(quiz, chunks) {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const questions = [];
  let removed = 0;
  let unverified = 0;

  for (const q of quiz.questions ?? []) {
    if (!q?.prompt || !Array.isArray(q.options) || q.options.length < 2) {
      removed += 1;
      continue;
    }
    const answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= q.options.length) {
      removed += 1;
      continue;
    }

    // The correct option carries the claim, so it is what gets checked — not
    // the stem, which is often a neutral question with little vocabulary.
    const claim = `${q.prompt} ${q.options[answer]}`;
    const check = checkCitations(claim, q.citations, chunkById);
    if (!check.ok) {
      removed += 1;
      continue;
    }

    const verified = q.verified !== false && check.confidence === 'grounded';
    if (!verified) unverified += 1;

    questions.push({
      id: q.id,
      topic: q.topic || 'General',
      difficulty: Math.min(3, Math.max(1, Number(q.difficulty) || 1)),
      prompt: q.prompt,
      options: q.options.map(String),
      answer,
      explanation: q.explanation || '',
      citations: check.resolved,
      verified,
    });
  }

  return { quiz: { questions }, report: { kept: questions.length, removed, unverified } };
}

/** Same contract for a single Q&A answer. */
export function groundAnswer(result, chunks) {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const answer = String(result?.answer ?? '').trim();
  if (!answer) {
    return { answer: 'The model did not return an answer. Try rephrasing the question.', citations: [], grounded: false };
  }
  if (result.grounded === false) return { answer, citations: [], grounded: false };

  const check = checkCitations(answer, result.citations, chunkById);
  if (!check.ok) {
    return {
      answer: `${answer}\n\nThis could not be traced back to your material, so treat it as unverified.`,
      citations: [],
      grounded: false,
    };
  }
  return { answer, citations: check.resolved, grounded: true };
}
