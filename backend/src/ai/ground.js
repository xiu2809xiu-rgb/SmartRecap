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
 *   2. Overlap — does the claim share the *distinctive* vocabulary of the chunk
 *      it cites? This catches the more dangerous failure: a true statement
 *      attached to the wrong slide, which resolution alone waves through.
 *      Terms are weighted by inverse document frequency across the chunk set,
 *      because inside one subject every chunk shares the generic vocabulary and
 *      an unweighted count is fooled by it. It is still lexical, not semantic,
 *      so its job is to catch a citation pointing at an unrelated passage — not
 *      to referee close paraphrase.
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

/**
 * Term weights across this document.
 *
 * A plain word-overlap count does not work inside a single subject. Every chunk
 * of a database lecture contains "table", "row" and "data", so a claim about
 * joins scores a comfortable 0.37 against a chunk about primary keys purely on
 * shared domain vocabulary — which is exactly the wrong-slide citation this
 * check exists to catch. (A test caught it: `test/extract.test.mjs`.)
 *
 * Weighting by inverse document frequency fixes it. A term in most chunks
 * carries almost no signal about *which* chunk a claim came from; a term in one
 * or two carries nearly all of it. The floor keeps the denominator non-zero
 * when every term is common.
 */
function buildIdf(chunks) {
  const n = chunks.length || 1;
  const df = new Map();
  for (const chunk of chunks) {
    for (const term of contentTokens(chunk.text)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return (term) => Math.max(0.05, Math.log(n / (1 + (df.get(term) ?? 0))));
}

/** Weighted share of the claim's distinctive vocabulary present in the source. */
function overlapRatio(claim, source, idf) {
  const a = contentTokens(claim);
  if (a.size === 0) return 1;
  const b = contentTokens(source);

  let matched = 0;
  let total = 0;
  for (const term of a) {
    const weight = idf(term);
    total += weight;
    if (b.has(term)) matched += weight;
  }
  return total === 0 ? 1 : matched / total;
}

// Below this, the claim and its cited chunk are about different things. With
// IDF weighting a genuine paraphrase lands well above 0.4, because the terms
// that survive weighting are the distinctive ones a paraphrase keeps.
const MIN_OVERLAP = 0.18;

// Above this the claim restates its source closely enough to call grounded
// rather than inferred; the reader shows the difference.
const CONFIDENT_OVERLAP = 0.45;

function checkCitations(text, citations, chunkById, idf) {
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

  const best = Math.max(...resolved.map((id) => overlapRatio(text, chunkById.get(id).text, idf)));
  if (best < MIN_OVERLAP) {
    const labels = resolved.map((id) => chunkById.get(id).label).join(', ');
    return {
      ok: false,
      resolved,
      reason: `Cited ${labels}, but that passage does not discuss this — the citation does not hold up.`,
    };
  }

  return { ok: true, resolved, confidence: best >= CONFIDENT_OVERLAP ? 'grounded' : 'inferred' };
}

/**
 * Filters a recap down to what the source actually supports.
 * Returns the cleaned recap plus a report the pipeline log can print.
 */
export function groundRecap(recap, chunks) {
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const idf = buildIdf(chunks);
  const ungrounded = [...(recap.ungrounded ?? [])];
  let kept = 0;
  let dropped = 0;

  const sections = (recap.sections ?? [])
    .map((section) => {
      const points = [];
      for (const point of section.points ?? []) {
        if (!point?.text) continue;
        const check = checkCitations(point.text, point.citations, chunkById, idf);
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
    const check = checkCitations(`${t.term} ${t.definition}`, t.citations, chunkById, idf);
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
  const idf = buildIdf(chunks);
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
    const check = checkCitations(claim, q.citations, chunkById, idf);
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
  const idf = buildIdf(chunks);
  const answer = String(result?.answer ?? '').trim();
  if (!answer) {
    return { answer: 'The model did not return an answer. Try rephrasing the question.', citations: [], grounded: false };
  }
  if (result.grounded === false) return { answer, citations: [], grounded: false };

  const check = checkCitations(answer, result.citations, chunkById, idf);
  if (!check.ok) {
    return {
      answer: `${answer}\n\nThis could not be traced back to your material, so treat it as unverified.`,
      citations: [],
      grounded: false,
    };
  }
  return { answer, citations: check.resolved, grounded: true };
}
