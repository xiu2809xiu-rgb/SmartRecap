import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, tokenStore, isDemo } from './api.js';
import { disableGoogleAutoSelect } from './google.js';

/**
 * Identity.
 *
 * The deployed backend authenticates against an Amazon Cognito user pool, but
 * every Cognito call happens inside Lambda — the browser only ever exchanges
 * email and password for the app's own bearer token. That keeps the client free
 * of an SDK, and it means the guest path below is a first-class route rather
 * than a hack: a guest gets a real token scoped to a throwaway identity, so the
 * same authorizer protects every endpoint and a demo can never be blocked by a
 * sign-in problem.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // No token means nobody is signed in — skip the round trip.
      if (!isDemo && !tokenStore.get()) {
        if (!cancelled) setStatus('ready');
        return;
      }
      try {
        const me = await api.auth.me();
        if (!cancelled) setUser(me ?? null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setStatus('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signup = useCallback(async (payload) => setUser(await api.auth.signup(payload)), []);
  const login = useCallback(async (payload) => setUser(await api.auth.login(payload)), []);
  const guest = useCallback(async () => setUser(await api.auth.guest()), []);
  const loginWithGoogle = useCallback(async (credential) => setUser(await api.auth.google(credential)), []);
  const loginWithFace = useCallback(async (image) => setUser(await api.auth.face(image)), []);
  const logout = useCallback(async () => {
    await api.auth.logout();
    // Clears Google's cached choice too, so the next sign-in shows the account
    // chooser instead of silently reusing the last one — which on a shared
    // library machine is the difference between logging out and not.
    disableGoogleAutoSelect();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthed: !!user,
      isGuest: !!user?.guest,
      signup,
      login,
      guest,
      loginWithGoogle,
      loginWithFace,
      logout,
    }),
    [user, status, signup, login, guest, loginWithGoogle, loginWithFace, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Route guard. Remembers where the user was headed so login can return them. */
export function RequireAuth({ children }) {
  const { isAuthed, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <AuthSplash />;
  if (!isAuthed) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function AuthSplash() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{ minHeight: '70vh', display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}
    >
      Loading your library…
    </div>
  );
}
