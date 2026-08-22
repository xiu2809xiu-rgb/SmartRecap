import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './auth.jsx';

/**
 * A session that ends on its own.
 *
 * This app is used on shared machines — polytechnic lab PCs, library desktops —
 * where the realistic failure is not an attacker but a student who walks away
 * from a signed-in browser. So a session lasts an hour, then asks whether
 * anyone is still there, and signs out if nothing answers within five minutes.
 *
 * Everything hangs off two absolute timestamps kept in storage rather than off
 * a running countdown, and that is the load-bearing decision here. A timer that
 * counts ticks is wrong in every interesting case:
 *
 *   - browsers throttle timers in background tabs, so a tick-counter runs slow
 *     exactly when someone has wandered off
 *   - a sleeping laptop fires no timers at all, so a machine closed at 20
 *     minutes and opened the next morning would still think 20 minutes had
 *     passed
 *   - a reload would restart the grace period, which turns a five-minute
 *     warning into an unlimited one for anyone who refreshes
 *
 * Comparing `Date.now()` against a stored deadline gets all three right: the
 * answer does not depend on whether this tab was awake to watch it happen.
 *
 * The timestamps live in localStorage under the owner's id, so several tabs
 * share one deadline — extending in one settles all of them — and so a record
 * left by a different account is never adopted.
 *
 * Known limitation: this trusts the device clock. Winding the clock back would
 * postpone the deadline. The server token is the real boundary, and revoking
 * sessions server-side is the fix for that; it is out of scope here.
 */

const KEY = 'smartrecap.session.v1';

export const SESSION_LIMIT_MS = 60 * 60 * 1000; // an hour of session
export const GRACE_MS = 5 * 60 * 1000; // then five minutes to answer

const SessionContext = createContext(null);

/* ------------------------------------------------------------------ storage */

// A private window, or storage turned off, must not take the app down. The
// deadline then lives only in memory: still correct inside this tab, just not
// shared with others or preserved across a reload.
let memoryFallback = null;

function readRecord() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : memoryFallback;
  } catch {
    return memoryFallback;
  }
}

function writeRecord(record) {
  memoryFallback = record;
  try {
    if (record) localStorage.setItem(KEY, JSON.stringify(record));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — the in-memory copy above still serves this tab */
  }
}

function freshRecord(ownerId) {
  const now = Date.now();
  return { ownerId, startedAt: now, warnAt: now + SESSION_LIMIT_MS, expiresAt: now + SESSION_LIMIT_MS + GRACE_MS };
}

/* -------------------------------------------------------------- attention */

/**
 * A short two-tone chime, synthesised rather than shipped as a file.
 *
 * An audio asset would be another request that has to succeed at exactly the
 * moment the network may be the reason nobody is looking at the screen.
 *
 * Autoplay policy can refuse this. That is fine and expected: it is one of
 * three signals, and the dialog itself is the one that cannot fail.
 */
function playChime() {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume?.();

    const at = ctx.currentTime;
    [880, 1320].forEach((frequency, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      // An envelope rather than a square start, so it reads as a notification
      // rather than a click.
      const start = at + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.14, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.34);
    });

    setTimeout(() => ctx.close?.(), 1200);
  } catch {
    /* no audio output, or a policy refusal — the dialog still shows */
  }
}

function notify(isGuest) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return null;
    // Only worth sending when the page is not the thing being looked at; if it
    // is visible the dialog has already done this job.
    if (document.visibilityState === 'visible') return null;
    const notification = new Notification('Still studying?', {
      body: isGuest
        ? 'Your SmartRecap guest session ends in 5 minutes. Open the tab to keep it.'
        : 'Your SmartRecap session ends in 5 minutes unless you confirm.',
      tag: 'smartrecap-session',
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
}

/** Flashes the tab title, for the case where audio is muted and notifications are off. */
function useTitleFlash(active) {
  useEffect(() => {
    if (!active) return undefined;
    const original = document.title;
    let on = false;
    const id = setInterval(() => {
      on = !on;
      document.title = on ? '⏳ Still there? — SmartRecap' : original;
    }, 1200);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [active]);
}

/* ------------------------------------------------------------------ provider */

export function SessionProvider({ children }) {
  const { user, status, isGuest, logout } = useAuth();
  const ownerId = user?.id ?? null;

  const [warning, setWarning] = useState(false);
  const [remainingMs, setRemainingMs] = useState(GRACE_MS);
  const notificationRef = useRef(null);
  const signingOut = useRef(false);

  useTitleFlash(warning);

  const closeSignals = useCallback(() => {
    notificationRef.current?.close?.();
    notificationRef.current = null;
  }, []);

  const endSession = useCallback(
    async (reason) => {
      if (signingOut.current) return;
      signingOut.current = true;
      closeSignals();
      setWarning(false);
      writeRecord(null);
      try {
        await logout();
      } finally {
        signingOut.current = false;
        // A full navigation rather than a router push: it guarantees every
        // provider's in-memory cache is dropped, which is the whole point of
        // signing out on a shared machine.
        window.location.assign(`/login?ended=${reason}`);
      }
    },
    [closeSignals, logout],
  );

  const extend = useCallback(() => {
    if (!ownerId) return;
    closeSignals();
    setWarning(false);
    writeRecord(freshRecord(ownerId));
  }, [closeSignals, ownerId]);

  // The clock. One interval, comparing now against the stored deadline, so a
  // throttled or suspended tab still reaches the right conclusion when it wakes.
  useEffect(() => {
    // While auth is still resolving we know nothing yet, so touch nothing. An
    // earlier version cleared the record here, which meant every reload wiped
    // the deadline and started a fresh hour -- the one-hour limit could be
    // dodged indefinitely by pressing F5.
    if (status !== 'ready') return undefined;

    if (!ownerId) {
      writeRecord(null);
      setWarning(false);
      return undefined;
    }

    let record = readRecord();
    // No record, or one belonging to a different account: start a fresh session
    // rather than inheriting someone else's deadline.
    if (!record || record.ownerId !== ownerId) {
      record = freshRecord(ownerId);
      writeRecord(record);
    }

    const tick = () => {
      const current = readRecord();
      if (!current || current.ownerId !== ownerId) return;
      const now = Date.now();

      if (now >= current.expiresAt) {
        // Covers the ordinary case and the closed-laptop case identically: if
        // the deadline is behind us, it does not matter why.
        void endSession('timeout');
        return;
      }

      if (now >= current.warnAt) {
        setRemainingMs(current.expiresAt - now);
        setWarning((wasWarning) => {
          if (!wasWarning) {
            playChime();
            notificationRef.current = notify(isGuest);
          }
          return true;
        });
      } else {
        setWarning(false);
      }
    };

    tick();
    const id = setInterval(tick, 1000);

    // A tab coming back to the foreground re-checks immediately rather than
    // waiting up to a second — and after a sleep this is what fires first.
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    // Another tab extended the session, signed out, or the token was cleared.
    const onStorage = (e) => {
      if (e.key === KEY) tick();
      if (e.key === 'smartrecap.token' && e.newValue === null) void endSession('elsewhere');
    };
    window.addEventListener('storage', onStorage);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [endSession, isGuest, ownerId, status]);

  useEffect(() => closeSignals, [closeSignals]);

  const value = useMemo(
    () => ({ warning, remainingMs, extend, endSession, isGuest }),
    [endSession, extend, isGuest, remainingMs, warning],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
