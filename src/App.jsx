import { Suspense, lazy, useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { RequireAuth } from './lib/auth.jsx';
import { usePrefs } from './lib/prefs.jsx';
import { AppShell } from './components/layout/Shells.jsx';
import {
  NavProgressProvider,
  PageTransition,
  RouteProgress,
  RouteSweep,
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
const Binders = lazy(() => import('./pages/Binders.jsx'));
const BinderDetail = lazy(() => import('./pages/BinderDetail.jsx'));
const BinderRecap = lazy(() => import('./pages/BinderRecap.jsx'));
const Upload = lazy(() => import('./pages/Upload.jsx'));
const Processing = lazy(() => import('./pages/Processing.jsx'));
const Recap = lazy(() => import('./pages/Recap.jsx'));
const Quiz = lazy(() => import('./pages/Quiz.jsx'));
const Matchmaking = lazy(() => import('./pages/Matchmaking.jsx'));
const Results = lazy(() => import('./pages/Results.jsx'));
const Flashcards = lazy(() => import('./pages/Flashcards.jsx'));
const Quizzes = lazy(() => import('./pages/Quizzes.jsx'));
const Forum = lazy(() => import('./pages/Forum.jsx'));
const Progress = lazy(() => import('./pages/Progress.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const SharedRecap = lazy(() => import('./pages/SharedRecap.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));
const Architecture = lazy(() => import('./pages/Architecture.jsx'));

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
      <div className="route-fallback-orbit">
        <MascotBadge size={96} state="thinking" />
      </div>
      <div className="route-fallback-copy">
        <strong>One moment</strong>
        <span>Getting that page ready</span>
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
      <RouteSweep />
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
            {/* For markers and maintainers, not students — deliberately absent
                from the app navigation. */}
            <Route path="/architecture" element={<Architecture />} />

            <Route
              path="/app"
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="binders" element={<Binders />} />
              <Route path="binders/:id" element={<BinderDetail />} />
              <Route path="upload" element={<Upload />} />
              <Route path="processing/:jobId" element={<Processing />} />
              <Route path="quizzes" element={<Quizzes />} />
              <Route path="forum" element={<Forum />} />
              <Route path="progress" element={<Progress />} />
              <Route path="settings" element={<Settings />} />
            </Route>

            <Route
              path="/app/binders/:id/recap"
              element={
                <RequireAuth>
                  <BinderRecap />
                </RequireAuth>
              }
            />
            <Route
              path="/app/material/:id/match"
              element={
                <RequireAuth>
                  <Matchmaking />
                </RequireAuth>
              }
            />
            <Route
              path="/app/material/:id/match/:lobbyId"
              element={
                <RequireAuth>
                  <Matchmaking />
                </RequireAuth>
              }
            />

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
