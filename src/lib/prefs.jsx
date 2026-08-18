import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * User preferences that change how the app renders, not just what it shows.
 *
 * `motion` is the important one. SmartRecap runs several WebGL canvases and a
 * 3D mascot; on `reduced` every one of them unmounts rather than merely
 * slowing down, because a paused shader still costs a GPU context. The
 * system-level `prefers-reduced-motion` seeds the default, and the user can
 * still override it either way.
 */

const KEY = 'smartrecap.prefs.v1';

const systemReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const defaults = () => ({
  motion: systemReducedMotion() ? 'reduced' : 'full',
  mascot: true,
  readingFont: 'default', // 'default' | 'hyperlegible'
  effects: true, // WebGL backdrops
});

function load() {
  if (typeof window === 'undefined') return defaults();
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
  } catch {
    return defaults();
  }
}

const PrefsContext = createContext(null);

export function PrefsProvider({ children }) {
  const [prefs, setPrefs] = useState(load);

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage disabled — preferences stay in memory for this session */
    }
    const root = document.documentElement;
    root.dataset.motion = prefs.motion;
    root.dataset.readingFont = prefs.readingFont;
  }, [prefs]);

  const value = useMemo(() => {
    const reduced = prefs.motion === 'reduced';
    return {
      ...prefs,
      reduced,
      // A single derived flag every heavy visual checks before mounting.
      allowEffects: prefs.effects && !reduced,
      allowMascot: prefs.mascot && !reduced,
      set: (patch) => setPrefs((p) => ({ ...p, ...patch })),
      toggle: (key) => setPrefs((p) => ({ ...p, [key]: !p[key] })),
    };
  }, [prefs]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used inside <PrefsProvider>');
  return ctx;
}
