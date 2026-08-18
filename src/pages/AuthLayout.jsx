import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import Mascot from '../mascot/Mascot.jsx';
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
        <div className="auth-mascot">
          <Mascot state={mascotState} size={300} caption />
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
