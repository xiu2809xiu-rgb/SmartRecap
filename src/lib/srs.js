/**
 * Spaced repetition — a trimmed SM-2.
 *
 * The full SM-2 algorithm grades recall 0-5. Asking a student to self-rate on a
 * six-point scale mid-revision is friction they will not pay, so the UI offers
 * three buttons (Again / Good / Easy) and this module maps them onto the
 * grades SM-2 actually distinguishes between.
 *
 * State per card: { ease, intervalDays, reps, lapses, dueAt, lastGrade }
 */

export const GRADES = {
  again: 0,
  good: 4,
  easy: 5,
};

const DAY = 86_400_000;
const MIN_EASE = 1.3;

export function newCardState(now = Date.now()) {
  return { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, dueAt: now, lastGrade: null };
}

export function review(state, grade, now = Date.now()) {
  const q = GRADES[grade] ?? GRADES.good;
  const next = { ...state, lastGrade: grade };

  if (q < 3) {
    // Failed recall: the card restarts, but the ease penalty persists so
    // repeatedly-missed cards keep coming back sooner than fresh ones.
    next.reps = 0;
    next.lapses = state.lapses + 1;
    next.intervalDays = 0;
    next.ease = Math.max(MIN_EASE, state.ease - 0.2);
    next.dueAt = now + 10 * 60 * 1000; // back in ten minutes, same session
    return next;
  }

  next.reps = state.reps + 1;
  next.ease = Math.max(MIN_EASE, state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

  if (next.reps === 1) next.intervalDays = 1;
  else if (next.reps === 2) next.intervalDays = 6;
  else next.intervalDays = Math.round(state.intervalDays * next.ease);

  next.dueAt = now + next.intervalDays * DAY;
  return next;
}

export const isDue = (state, now = Date.now()) => !state || state.dueAt <= now;

export function dueCount(cards, now = Date.now()) {
  return cards.filter((c) => isDue(c.srs, now)).length;
}

/** Cards due now, hardest first so the weakest material is seen while fresh. */
export function nextDue(cards, now = Date.now()) {
  return cards
    .filter((c) => isDue(c.srs, now))
    .sort((a, b) => (a.srs?.ease ?? 2.5) - (b.srs?.ease ?? 2.5));
}

function cleanSubject(definition = '') {
  const text = String(definition).replace(/\s+/g, ' ').trim();
  const match = text.match(/^(.{3,120}?)\s+(?:is|are|means|refers to|represents|describes|requires|allows|enables)\b/i);
  if (!match) return '';
  return match[1].replace(/[,;:]$/, '').trim();
}

function recallQuestion(term, definition) {
  const value = String(term || '').trim();
  if (!/^study concept\s+\d+$/i.test(value) && value) return `What is ${value}?`;
  const subject = cleanSubject(definition);
  if (subject) return `How is ${subject.replace(/^The\s+/, 'the ')} defined?`;
  const clue = String(definition || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  return clue ? `Which concept explains this idea: “${clue}${clue.length >= 110 ? '…' : ''}”?` : 'What concept does this card explain?';
}

function uniqueFront(front, seen) {
  const base = front.trim();
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate.toLowerCase())) candidate = `${base} (${suffix++})`;
  seen.add(candidate.toLowerCase());
  return candidate;
}

/** Turns grounded definitions and quiz questions into active-recall cards. */
export function buildFlashcards(material) {
  const cards = [];
  const seen = new Set();
  for (const term of material.recap?.keyTerms ?? []) {
    cards.push({
      id: `fc_term_${term.term.replace(/\W+/g, '_').toLowerCase()}`,
      front: uniqueFront(recallQuestion(term.term, term.definition), seen),
      back: term.definition,
      topic: 'Key terms',
      citations: term.citations ?? [],
      srs: newCardState(),
    });
  }
  for (const q of material.quiz?.questions ?? []) {
    if (!q.verified) continue;
    const type = q.type ?? 'single';
    const answer =
      type === 'short'
        ? q.modelAnswer
        : type === 'multi'
          ? (q.answer ?? []).map((index) => q.options?.[index]).filter(Boolean).join('; ')
          : q.options?.[q.answer];
    cards.push({
      id: `fc_${q.id}`,
      front: uniqueFront(q.prompt, seen),
      back: `${answer ?? ''}\n\n${q.explanation}`,
      topic: q.topic,
      citations: q.citations ?? [],
      srs: newCardState(),
    });
  }
  return cards;
}

/** Upgrades already-saved generic fallback fronts without resetting SRS progress. */
export function repairFlashcards(cards, material) {
  const replacements = new Map(buildFlashcards(material).map((card) => [card.id, card.front]));
  return cards.map((card) => /^study concept\s+\d+$/i.test(String(card.front || '').trim()) && replacements.has(card.id)
    ? { ...card, front: replacements.get(card.id) }
    : card);
}
