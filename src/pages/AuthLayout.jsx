import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { lazy, Suspense } from 'react';
import useAvatarModel from '../components/avatar/useAvatarModel.js';

// Only reached once the probe says the model is there, so the three.js chunk
// is never downloaded on an auth page that is going to show Rec instead.
const AvatarStage = lazy(() => import('../components/avatar/AvatarStage.jsx'));
import { Brand } from '../components/layout/Shells.jsx';
import { Icon, Spinner } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import BlurText from '../reactbits/BlurText.jsx';
import ElectricBorder from '../reactbits/ElectricBorder.jsx';
import '../reactbits/ElectricBorder.css';
import './auth.css';

/**
 * Shared frame for sign-in and sign-up.
 *
 * The guest button is deliberately not a de-emphasised footnote. A judge, a
 * classmate or a marker should be able to reach a working library in one click
 * without inventing credentials, and a sign-in problem should never be able to
 * block a live demo.
 */
export default function AuthLayout({ title, subtitle, children, footer, methods, mascotState = 'wave' }) {
  const { guest } = useAuth();
  const avatar = useAvatarModel();
  const { allowEffects } = usePrefs();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const from = location.state?.from ?? '/app';

  const onGuest = async () => {
    setBusy(true);
    setError(null);
    try {
      await guest();
      navigate(from, { replace: true });
    } catch (e) {
      setError(e.message ?? 'Could not start a guest session.');
    } finally {
      setBusy(false);
    }
  };

  const card = (
    <div className="auth-card panel">
      <h1 className="auth-title">
        <BlurText text={title} animateBy="words" delay={40} direction="bottom" />
      </h1>
      <p className="auth-sub">{subtitle}</p>

      {children}

      {/* Google and face sign-in sit above the guest option: they are ways of
          being *you*, whereas guest is a way of skipping that. Grouping them
          together would suggest they are the same kind of choice. */}
      {methods && (
        <>
          <div className="auth-divider">
            <span>or</span>
          </div>
          {methods}
        </>
      )}

      <div className="auth-divider">
        <span>{methods ? 'in a hurry?' : 'or'}</span>
      </div>

      <button className="btn btn-ghost auth-guest" onClick={onGuest} disabled={busy}>
        {busy ? <Spinner size={17} /> : <Icon name="bolt" size={18} />}
        Continue as a guest
      </button>
      <p className="auth-guest-note">
        A guest session gets a real account scoped to this browser. Sign up later and your library comes with you.
      </p>

      {error && (
        <p className="field-error auth-error" role="alert">
          {error}
        </p>
      )}

      <p className="auth-foot">{footer}</p>
    </div>
  );

  return (
    <div className="auth">
      <AuroraBackdrop variant="aurora" className="backdrop-fixed" opacity={0.6} />

      <header className="auth-head shell">
        <Brand />
        <Link to="/" className="btn btn-ghost btn-sm">
          <Icon name="arrow_back" size={16} />
          Back to home
        </Link>
      </header>

      <main className="auth-main shell" id="main">
        {/* The builder's own avatar when it is available, Rec when it is not.
            Both are the same slot: this is the first screen anyone sees, and
            it should be a face rather than an empty half of the page. Rec
            remains the fallback for reduced motion, 3D turned off, or a
            missing model file — never a hole. */}
        <div className={`auth-mascot ${avatar.ready ? 'has-avatar' : ''}`}>
          {avatar.ready ? (
            <Suspense fallback={<Mascot state={mascotState} size={300} caption />}>
              {/* Above the figure rather than below it: the label reads as
                  belonging to the person, and the space under the model is
                  where the feet swing during several of the clips. */}
              <p className="auth-learner">
                <span className="auth-learner-role">Learner</span>
                Richie Koh
              </p>
              <AvatarStage url={avatar.url} />
            </Suspense>
          ) : (
            <Mascot state={mascotState} size={300} caption />
          )}
        </div>
        {/* ElectricBorder's `chaos` is the displacement amplitude, not a style
            knob. Past roughly 0.2 the noise pushes the traced border far enough
            inward that it crosses the card and reads as a crack through the
            content — which is exactly what 0.42 was doing here. */}
        {allowEffects ? (
          <ElectricBorder color="#a78bfa" speed={0.7} chaos={0.14} borderRadius={26} className="auth-border">
            {card}
          </ElectricBorder>
        ) : (
          card
        )}
      </main>
    </div>
  );
}
