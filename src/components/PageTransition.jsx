import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { usePrefs } from '../lib/prefs.jsx';
import './pagetransition.css';

/**
 * Moving between pages.
 *
 * A route change hides three different waits, and one animation cannot cover
 * all of them:
 *
 *   1. `RouteSweep` — the signature. Aurora bands rake across the viewport on
 *      every navigation. This is the bit you notice.
 *   2. `RouteProgress` — the bar across the top, for when a lazy chunk is
 *      actually still downloading.
 *   3. `PageTransition` — the arriving page's own entrance, timed to land in
 *      the gap the sweep opens.
 *
 * The sweep is `pointer-events: none` and the incoming page is interactive
 * underneath it from the first frame, so none of this costs the user time. That
 * is the difference between a transition and a loading screen: a transition
 * covers work that is already finished.
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

/* -------------------------------------------------------------- the sweep */

// Violet leads, magenta carries the weight, cyan trails. Staggering them is
// what makes it read as one raking gesture rather than three parallel bars.
const BANDS = ['is-violet', 'is-magenta', 'is-cyan'];

// Longest band duration plus its delay, from pagetransition.css. The sweep
// unmounts on this timer rather than on an exit animation.
const SWEEP_MS = 840;

/**
 * Driven by CSS keyframes and a timeout rather than AnimatePresence.
 *
 * The first version used `<AnimatePresence>` with an `exit`, and the bands
 * never unmounted — every navigation stacked three more onto the DOM (measured:
 * twelve after four navigations, still climbing). A transition that leaks nodes
 * on every click is worse than no transition.
 *
 * A mount/unmount pair on an explicit timer cannot leak: the elements exist for
 * exactly as long as the keyframes run. Restarting is a key change, which is
 * also what makes a rapid second navigation cut the first sweep short instead
 * of queueing behind it.
 */
export function RouteSweep() {
  const { pathname } = useLocation();
  const { reduced } = usePrefs();
  const [run, setRun] = useState(0);
  const [active, setActive] = useState(false);
  const first = useRef(true);
  const timer = useRef(0);
  // The path a click has already swept for. React commits the matching
  // `useLocation()` update up to a second later, and without this the same
  // navigation sweeps twice — once on the click, once on the commit.
  const claimed = useRef(null);

  const fire = useCallback((forPath) => {
    if (forPath) claimed.current = forPath;
    setRun((n) => n + 1);
    setActive(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), SWEEP_MS);
  }, []);

  /**
   * Fired from the click, not from the committed route.
   *
   * React Router wraps navigation in a transition, so `useLocation()` does not
   * update until React commits the new tree — measured at ~800ms after the
   * click on a route whose page mounts a lazy boundary. Waiting for that put a
   * dead pause between the click and any feedback, which is precisely the gap
   * this animation exists to fill.
   */
  useEffect(() => {
    if (reduced) return undefined;

    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target.closest?.('a[href]');
      if (!link) return;

      const href = link.getAttribute('href');
      // Internal, in-app, and actually going somewhere else.
      if (!href?.startsWith('/') || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = href.split('?')[0].split('#')[0];
      if (target === window.location.pathname) return;

      fire(target);
    };

    // Capture phase: the router's own handler stops propagation on some links.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [fire, reduced]);

  // Still covers programmatic navigation — finishing a quiz, signing in, the
  // pipeline redirecting to a finished recap — where there is no link click.
  useEffect(() => {
    if (first.current) {
      // No sweep on first paint: arriving at a page you asked for directly
      // should not look like you navigated within the app.
      first.current = false;
      return;
    }
    // A click already swept for this destination; this is the late commit.
    if (claimed.current === pathname) {
      claimed.current = null;
      return;
    }
    fire();
  }, [pathname, fire]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (reduced || !active) return null;

  return (
    <div className="route-sweep" aria-hidden="true">
      {BANDS.map((tone, i) => (
        <span key={`${tone}-${run}`} className={`sweep-band ${tone}`} style={{ animationDelay: `${i * 70}ms` }} />
      ))}
    </div>
  );
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
      // Two steps rather than one long CSS animation to 90%: a fast jump to 35%
      // makes the click feel acknowledged, then a slow crawl signals "still
      // working" without ever implying it knows the real progress. It does not.
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
      <span className="route-progress-bar" style={{ width: `${width}%` }}>
        <i className="route-progress-shimmer" />
      </span>
      <span className="route-progress-glow" style={{ left: `${width}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------ the entrance */

const ENTER = {
  initial: { opacity: 0, y: 26, scale: 0.985, filter: 'blur(10px)' },
  animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -14, scale: 0.995, filter: 'blur(8px)' },
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
                // Delayed just enough that the page lands as the first band
                // clears it, rather than racing the sweep.
                duration: isStudy ? 0.48 : 0.42,
                delay: 0.1,
                ease: [0.16, 0.84, 0.34, 1],
                filter: { duration: 0.34, delay: 0.1 },
              }
        }
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
