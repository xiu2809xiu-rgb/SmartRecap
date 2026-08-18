/**
 * Turning extracted pages into citable chunks.
 *
 * A chunk is the unit the model cites and the reader displays, so it has two
 * competing requirements: small enough that "this claim came from here" is a
 * useful statement, and large enough to carry a complete idea. A chunk that is
 * half a sentence makes citations precise and useless.
 *
 * Empty pages are dropped rather than renumbered, so a chunk labelled
 * "Slide 12" is genuinely slide 12 of the file the student uploaded. Renumbering
 * would make every citation subtly wrong the moment a title slide is skipped.
 */

const MAX_CHARS = 1400;
const MIN_CHARS = 60;
const MERGE_UNDER = 260;

/** Splits on sentence ends, keeping the terminator with its sentence. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitLong(text) {
  if (text.length <= MAX_CHARS) return [text];
  const out = [];
  let current = '';
  for (const s of sentences(text)) {
    if (current && current.length + s.length + 1 > MAX_CHARS) {
      out.push(current.trim());
      current = '';
    }
    // A single sentence longer than the budget is left whole: cutting mid-
    // sentence produces a chunk nobody can read as a source.
    current = current ? `${current} ${s}` : s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function chunkPages(pages) {
  const chunks = [];
  let counter = 0;
  const push = (label, page, text) => {
    counter += 1;
    chunks.push({ id: `c${counter}`, label, page, text });
  };

  let pending = null; // a short page waiting to be merged forward

  for (const page of pages) {
    const text = (page.text ?? '').trim();
    if (text.length < MIN_CHARS) continue; // title slides, page numbers, blanks

    if (pending) {
      // Two consecutive thin slides are one idea split across a build.
      if (pending.text.length + text.length <= MAX_CHARS) {
        push(`${pending.label}–${page.label.replace(/^\D+/, '')}`, pending.page, `${pending.text}\n\n${text}`);
        pending = null;
        continue;
      }
      push(pending.label, pending.page, pending.text);
      pending = null;
    }

    if (text.length < MERGE_UNDER) {
      pending = { label: page.label, page: page.page, text };
      continue;
    }

    const parts = splitLong(text);
    parts.forEach((part, i) => {
      push(parts.length > 1 ? `${page.label} (${i + 1}/${parts.length})` : page.label, page.page, part);
    });
  }

  if (pending) push(pending.label, pending.page, pending.text);
  return chunks;
}

/**
 * Free-tier models have real context limits and real rate limits, and the whole
 * chunk set is sent twice — once for the recap, once for the quiz. A 200-slide
 * deck would blow both.
 *
 * When trimming is needed, chunks are dropped by even sampling across the
 * document rather than by truncating the tail, so a recap of a long deck still
 * covers its ending. `dropped` is reported so the pipeline can say what
 * happened instead of silently summarising two thirds of a file.
 */
export function fitToBudget(chunks, maxChars = 28_000) {
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  if (total <= maxChars) return { chunks, dropped: 0, sampled: false };

  const keepCount = Math.max(1, Math.floor((chunks.length * maxChars) / total));
  const step = chunks.length / keepCount;
  const kept = [];
  for (let i = 0; i < keepCount; i += 1) kept.push(chunks[Math.floor(i * step)]);

  // Re-id so citations stay contiguous, but keep the original labels — the
  // student's slide numbers must not shift.
  const renumbered = kept.map((c, i) => ({ ...c, id: `c${i + 1}` }));
  return { chunks: renumbered, dropped: chunks.length - renumbered.length, sampled: true };
}
