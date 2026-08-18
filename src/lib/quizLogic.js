export const TIME_LIMIT_SECONDS = 20;

/** Faster correct answers score more, mirroring a Kahoot-style speed bonus. */
export function pointsForAnswer(correct, timeLeft, timeLimit = TIME_LIMIT_SECONDS) {
  if (!correct) return 0;
  return Math.round(500 + 500 * (Math.max(timeLeft, 0) / timeLimit));
}

/** Consecutive correct answers earn a small multiplier, capped at +50%. */
export function streakMultiplier(streak) {
  return 1 + Math.min(streak, 5) * 0.1;
}
