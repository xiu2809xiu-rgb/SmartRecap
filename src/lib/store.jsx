import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';

/**
 * Library state: the user's materials and their quiz attempts.
 *
 * Both lists are small and read on nearly every screen, so they are fetched
 * once per session and mutated locally after writes rather than refetched.
 */

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const { isAuthed } = useAuth();
  const [materials, setMaterials] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const [m, a] = await Promise.all([api.materials.list(), api.quiz.attempts()]);
      setMaterials(m ?? []);
      setAttempts(a ?? []);
      setStatus('ready');
    } catch (e) {
      setError(e);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (isAuthed) refresh();
    else {
      setMaterials([]);
      setAttempts([]);
      setStatus('idle');
    }
  }, [isAuthed, refresh]);

  const upsertMaterial = useCallback((material) => {
    setMaterials((list) => {
      const i = list.findIndex((m) => m.id === material.id);
      if (i === -1) return [material, ...list];
      const next = [...list];
      next[i] = { ...next[i], ...material };
      return next;
    });
  }, []);

  const removeMaterial = useCallback(async (id) => {
    setMaterials((list) => list.filter((m) => m.id !== id));
    setAttempts((list) => list.filter((a) => a.materialId !== id));
    await api.materials.remove(id);
  }, []);

  const renameMaterial = useCallback(async (id, title) => {
    setMaterials((list) => list.map((m) => (m.id === id ? { ...m, title } : m)));
    await api.materials.rename(id, title);
  }, []);

  const addAttempt = useCallback((attempt) => setAttempts((list) => [attempt, ...list]), []);

  const value = useMemo(
    () => ({
      materials,
      attempts,
      status,
      error,
      refresh,
      upsertMaterial,
      removeMaterial,
      renameMaterial,
      addAttempt,
      materialById: (id) => materials.find((m) => m.id === id),
      attemptsFor: (id) => attempts.filter((a) => a.materialId === id),
    }),
    [materials, attempts, status, error, refresh, upsertMaterial, removeMaterial, renameMaterial, addAttempt],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>');
  return ctx;
}

/* ---------------------------------------------------------------------------
   Derived study statistics. Kept here so the dashboard and analytics screens
   agree on what a "streak" or a "mastery score" means.
   ------------------------------------------------------------------------ */

const DAY = 86_400_000;
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

export function studyStats(materials, attempts, now = Date.now()) {
  const days = new Set(attempts.map((a) => dayKey(a.at)));

  // Streak counts back from today; a gap of one full day ends it.
  let streak = 0;
  for (let i = 0; ; i += 1) {
    const key = dayKey(now - i * DAY);
    if (days.has(key)) streak += 1;
    else if (i > 0) break;
    else if (!days.has(dayKey(now - DAY))) break;
  }

  const scored = attempts.filter((a) => a.total > 0);
  const averageScore = scored.length ? Math.round(scored.reduce((n, a) => n + a.score, 0) / scored.length) : null;

  // Mastery is per topic across every attempt, not per attempt.
  const topicTotals = new Map();
  for (const attempt of attempts) {
    for (const t of attempt.byTopic ?? []) {
      const prev = topicTotals.get(t.topic) ?? { correct: 0, total: 0 };
      topicTotals.set(t.topic, { correct: prev.correct + t.correct, total: prev.total + t.total });
    }
  }
  const topics = [...topicTotals.entries()]
    .map(([topic, v]) => ({ topic, ...v, mastery: v.total ? Math.round((v.correct / v.total) * 100) : 0 }))
    .sort((a, b) => a.mastery - b.mastery);

  return {
    streak,
    averageScore,
    topics,
    weakTopics: topics.filter((t) => t.mastery < 70),
    materialCount: materials.length,
    attemptCount: attempts.length,
    questionsAnswered: attempts.reduce((n, a) => n + (a.total ?? 0), 0),
    minutesSaved: materials.reduce((n, m) => n + Math.max(0, (m.pageCount ?? 0) * 1.5 - (m.recap?.readMinutes ?? 0)), 0),
  };
}

/** Last 12 weeks of activity, oldest first — the heatmap's input. */
export function activityGrid(attempts, now = Date.now(), weeks = 12) {
  const counts = new Map();
  for (const a of attempts) counts.set(dayKey(a.at), (counts.get(dayKey(a.at)) ?? 0) + 1);

  const today = new Date(now);
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // Wind back to the Monday that starts the earliest visible week.
  const startOffset = (end.getDay() + 6) % 7;
  const start = new Date(end.getTime() - (startOffset + (weeks - 1) * 7) * DAY);

  const cells = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const date = new Date(start.getTime() + i * DAY);
    const key = dayKey(date);
    cells.push({ date, key, count: counts.get(key) ?? 0, future: date.getTime() > end.getTime() });
  }
  return cells;
}
