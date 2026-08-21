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

const media = (query) => typeof window !== 'undefined' && window.matchMedia?.(query).matches;
const systemReducedMotion = () => media('(prefers-reduced-motion: reduce)');
const systemPrefersLight = () => media('(prefers-color-scheme: light)');

export const THEMES = [
  {
    value: 'aurora',
    label: 'Aurora',
    hint: 'Dark app, light reading pages',
    swatch: ['#0b0616', '#5d34d0', '#f6f4fb'],
  },
  {
    value: 'midnight',
    label: 'Midnight',
    hint: 'Dark everywhere, including recaps',
    swatch: ['#0b0616', '#5d34d0', '#150c26'],
  },
  {
    value: 'daylight',
    label: 'Daylight',
    hint: 'Light everywhere',
    swatch: ['#f6f4fb', '#6d4fe0', '#ffffff'],
  },
  {
    value: 'system',
    label: 'System',
    hint: 'Follow your device',
    swatch: ['#0b0616', '#6d4fe0', '#f6f4fb'],
  },
];

export const FONT_SIZES = [
  { value: 'sm', label: 'Small', scale: 93.75 },
  { value: 'md', label: 'Default', scale: 100 },
  { value: 'lg', label: 'Large', scale: 112.5 },
  { value: 'xl', label: 'Larger', scale: 125 },
];

const defaults = () => ({
  motion: systemReducedMotion() ? 'reduced' : 'full',
  mascot: true,
  readingFont: 'default', // 'default' | 'hyperlegible'
  effects: true, // WebGL backdrops
  theme: 'aurora', // see THEMES
  fontSize: 'md', // see FONT_SIZES
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

/** `system` is not a look of its own — it resolves to one of the real themes. */
const resolveTheme = (theme) => (theme === 'system' ? (systemPrefersLight() ? 'daylight' : 'aurora') : theme);

const PrefsContext = createContext(null);

export function PrefsProvider({ children }) {
  const [prefs, setPrefs] = useState(load);
  const [systemLight, setSystemLight] = useState(systemPrefersLight);

  // Only matters while the theme is `system`, but the listener is cheap and
  // unconditional hooks are simpler to reason about than conditional ones.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return undefined;
    const onChange = (e) => setSystemLight(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme = prefs.theme === 'system' ? (systemLight ? 'daylight' : 'aurora') : prefs.theme;

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage disabled — preferences stay in memory for this session */
    }
    const root = document.documentElement;
    root.dataset.motion = prefs.motion;
    root.dataset.readingFont = prefs.readingFont;
    root.dataset.theme = resolvedTheme;

    // Set on the root as a percentage so every rem-based size scales together.
    // Padding and layout stay in px on purpose — the text grows, the furniture
    // does not, which is what people actually want from a text-size control.
    const size = FONT_SIZES.find((f) => f.value === prefs.fontSize) ?? FONT_SIZES[1];
    root.style.fontSize = `${size.scale}%`;
    // Also exposed as an attribute, because a media query cannot see this.
    // `em` and `rem` inside a media query resolve against the browser's own
    // default, never against a font-size set on :root -- so a breakpoint that
    // has to move with the text setting has to read it from a selector.
    root.dataset.fontSize = size.value;
  }, [prefs, resolvedTheme]);

  const value = useMemo(() => {
    const reduced = prefs.motion === 'reduced';
    return {
      ...prefs,
      reduced,
      resolvedTheme,
      // A single derived flag every heavy visual checks before mounting.
      allowEffects: prefs.effects && !reduced,
      allowMascot: prefs.mascot && !reduced,
      set: (patch) => setPrefs((p) => ({ ...p, ...patch })),
      toggle: (key) => setPrefs((p) => ({ ...p, [key]: !p[key] })),
      reset: () => setPrefs(defaults()),
    };
  }, [prefs, resolvedTheme]);

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used inside <PrefsProvider>');
  return ctx;
}

export { resolveTheme };
