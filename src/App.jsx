import { Suspense, lazy, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { RequireAuth } from './lib/auth.jsx';
import { usePrefs } from './lib/prefs.jsx';
import { AppShell } from './components/layout/Shells.jsx';
import {
  NavProgressProvider,
  PageTransition,
  RouteProgress,
  useSuspenseProgress,
} from './components/PageTransition.jsx';
import { MascotBadge } from './mascot/Mascot.jsx';
import ClickSpark from './reactbits/ClickSpark.jsx';
import './pages/route.css';

import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';

// Everything behind the app shell is split out: the marketing route is what
// most first visits load, and it should not pay for the reader or the charts.
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Upload = lazy(() => import('./pages/Upload.jsx'));
const Processing = lazy(() => import('./pages/Processing.jsx'));
const Recap = lazy(() => import('./pages/Recap.jsx'));
const Quiz = lazy(() => import('./pages/Quiz.jsx'));
const Results = lazy(() => import('./pages/Results.jsx'));
const Flashcards = lazy(() => import('./pages/Flashcards.jsx'));
const Progress = lazy(() => import('./pages/Progress.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const SharedRecap = lazy(() => import('./pages/SharedRecap.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }, [pathname]);
  return null;
}

/**
 * Shown only while a route's chunk is still downloading. On a warm cache that
 * is a few milliseconds and nobody sees this; on campus wifi it is the
 * difference between "loading" and "broken".
 */
function RouteFallback() {
  useSuspenseProgress();
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <MascotBadge size={104} state="thinking" />
      <div className="route-fallback-copy">
        <strong>One moment</strong>
        <span>Getting that page ready</span>
      </div>
      <div className="route-fallback-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export default function App() {
  const { allowEffects } = usePrefs();
  const location = useLocation();

  const routes = (
    <>
      <ScrollToTop />
      <RouteProgress />
      {/* Routes are given an explicit location so AnimatePresence sees a stable
          key per page rather than re-keying on every render. */}
      <PageTransition>
        <Suspense fallback={<RouteFallback />}>
          <Routes location={location}>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            {/* Public read-only view of a shared recap. */}
            <Route path="/s/:token" element={<SharedRecap />} />

            <Route
              path="/app"
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="upload" element={<Upload />} />
              <Route path="processing/:jobId" element={<Processing />} />
              <Route path="progress" element={<Progress />} />
              <Route path="settings" element={<Settings />} />
            </Route>

            {/* The study surface sits outside the app shell — it swaps the whole
                token set to the light luminance and runs its own slim chrome. */}
            <Route
              path="/app/material/:id"
              element={
                <RequireAuth>
                  <Recap />
                </RequireAuth>
              }
            />
            <Route
              path="/app/material/:id/quiz"
              element={
                <RequireAuth>
                  <Quiz />
                </RequireAuth>
              }
            />
            <Route
              path="/app/material/:id/results/:attemptId"
              element={
                <RequireAuth>
                  <Results />
                </RequireAuth>
              }
            />
            <Route
              path="/app/material/:id/flashcards"
              element={
                <RequireAuth>
                  <Flashcards />
                </RequireAuth>
              }
            />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </PageTransition>
    </>
  );

  // Click feedback is a global affordance, but it is also a full-page canvas —
  // it comes off entirely under reduced motion rather than being slowed down.
  return (
    <NavProgressProvider>
      {allowEffects ? (
        <ClickSpark sparkColor="#a78bfa" sparkCount={9} sparkRadius={19} sparkSize={9} duration={430} extraScale={1.1}>
          {routes}
        </ClickSpark>
      ) : (
        routes
      )}
    </NavProgressProvider>
  );
}
