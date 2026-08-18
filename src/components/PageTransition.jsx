import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefs } from '../lib/prefs.jsx';
import './pagetransition.css';

/**
 * Moving between pages.
 *
 * Three pieces, because a route change has three different waits hiding in it
 * and one animation cannot cover all of them:
 *
 *   1. `RouteProgress` — the bar across the top. It runs whenever a navigation
 *      is in flight, including the lazy chunk fetch, which is the only part
 *      that can actually take a noticeable amount of time.
 *   2. `PageTransition` — the enter animation on the new page.
 *   3. `RouteFallback` — the branded hold for a chunk that is genuinely slow.
 *
 * The deliberate choice here is **enter-only**. `AnimatePresence mode="wait"`
 * looks lovely in a demo and costs you the exit duration on every single
 * navigation — the app feels slower the more you use it. Fading the outgoing
 * page out while the incoming one is already arriving means the click feels
 * instant and the motion is still smooth.
 */

/* ------------------------------------------------------------------ context */

const NavProgressContext = createContext(null);

export function NavProgressProvider({ children }) {
  // A count, not a boolean: a lazy chunk and a data fetch can be pending at the
  // same time, and whichever finishes first must not clear the other's bar.
  const [pending, setPending] = useState(0);

  const value = useMemo(
    () => ({
      busy: pending > 0,
      start: () => setPending((n) => n + 1),
      done: () => setPending((n) => Math.max(0, n - 1)),
    }),
    [pending],
  );

  return <NavProgressContext.Provider value={value}>{children}</NavProgressContext.Provider>;
}

export function useNavProgress() {
  return useContext(NavProgressContext) ?? { busy: false, start: () => {}, done: () => {} };
}

/**
 * Marks a navigation as in flight for as long as the component that mounted it
 * is suspended. Suspense unmounts the fallback the instant the chunk resolves,
 * so the cleanup doubles as "finished".
 */
export function useSuspenseProgress() {
  const { start, done } = useNavProgress();
  useEffect(() => {
    start();
    return done;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/* ------------------------------------------------------------------- the bar */

export function RouteProgress() {
  const { busy } = useNavProgress();
  const { reduced } = usePrefs();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const timers = useRef([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => {
    clearTimers();

    if (busy) {
      setVisible(true);
      setWidth(0);
      // Two steps rather than a CSS animation to 90%: a fast jump to 35% makes
      // the click feel acknowledged, then a slow crawl signals "still working"
      // without ever implying it knows the real progress. It does not.
      timers.current.push(setTimeout(() => setWidth(35), 20));
      timers.current.push(setTimeout(() => setWidth(72), 320));
      timers.current.push(setTimeout(() => setWidth(88), 1200));
      return clearTimers;
    }

    if (visible) {
      setWidth(100);
      timers.current.push(setTimeout(() => setVisible(false), 260));
      timers.current.push(setTimeout(() => setWidth(0), 460));
    }
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // Under reduced motion the bar would be a jumping block rather than a sweep,
  // so it is replaced by a still, announced strip.
  if (reduced) {
    return busy ? (
      <div className="route-progress is-static" role="status" aria-label="Loading the page" />
    ) : null;
  }

  if (!visible) return null;

  return (
    <div className="route-progress" role="status" aria-label="Loading the page">
      <span className="route-progress-bar" style={{ width: `${width}%` }} />
      <span className="route-progress-glow" style={{ left: `${width}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------ the transition */

const ENTER = {
  initial: { opacity: 0, y: 14, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -8, filter: 'blur(4px)' },
};

const STILL = { initial: false, animate: {}, exit: {} };

export function PageTransition({ children }) {
  const { pathname } = useLocation();
  const { reduced } = usePrefs();

  // The study surfaces are a different luminance, so they get a slightly
  // longer, calmer entrance — arriving at something you are about to read
  // should not feel like a swipe.
  const isStudy = pathname.includes('/material/');
  const variants = reduced ? STILL : ENTER;

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={pathname}
        className="page-transition"
        initial={variants.initial}
        animate={variants.animate}
        exit={variants.exit}
        transition={
          reduced
            ? { duration: 0 }
            : {
                duration: isStudy ? 0.34 : 0.26,
                ease: [0.22, 0.61, 0.36, 1],
                filter: { duration: isStudy ? 0.28 : 0.2 },
              }
        }
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
