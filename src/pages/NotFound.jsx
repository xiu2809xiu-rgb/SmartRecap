import { Link, useLocation } from 'react-router-dom';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import ParticleText from '../components/ParticleText.jsx';
import Mascot from '../components/mascot/Mascot.jsx';
import { Brand, useSurface } from '../components/layout/Shells.jsx';
import { Icon } from '../components/ui.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import './notfound.css';

/**
 * 404.
 *
 * SmartRecap's whole argument is that a claim which cannot be traced back to a
 * source gets dropped and shown to you with the reason, rather than quietly
 * disappearing. A URL that does not resolve is the same failure, so this page
 * is written in the same language the reader uses for a dropped claim: here is
 * what was asked for, here is why it could not be resolved, here is what does
 * exist.
 *
 * The hero is particles rather than a headline because the one useful thing a
 * 404 can do beyond pointing you home is not feel like a wall. It is canvas 2D,
 * so it works without WebGL — see `components/ParticleText.jsx` for why that
 * matters on this page specifically.
 */
export default function NotFound() {
  const { pathname } = useLocation();
  const { allowMascot } = usePrefs();

  // Nothing else resets this. Arriving at a bad URL from a study page would
  // otherwise leave `data-surface="study"` on <html>, painting a light page
  // behind a dark aurora backdrop.
  useSurface(null);

  return (
    <div className="notfound">
      <AuroraBackdrop variant="aurora" className="backdrop-fixed" opacity={0.5} />

      <header className="shell notfound-bar">
        <Brand />
      </header>

      <main className="shell notfound-main" id="main">
        <div className="notfound-hero">
          <ParticleText text="404" />
          <p className="sr-only">Error 404</p>
          {allowMascot && (
            <div className="notfound-mascot" aria-hidden="true">
              <Mascot state="confused" size={190} shadow={false} />
            </div>
          )}
        </div>

        <h1 className="notfound-title">This one did not resolve</h1>
        <p className="lede notfound-lede">
          SmartRecap drops anything it cannot trace back to a source. That applies to links too.
        </p>

        <div className="notfound-drop">
          <p className="notfound-drop-head">
            <Icon name="rule" size={17} />
            What you asked for
          </p>
          <p className="notfound-path">
            <code>{pathname}</code>
          </p>
          <p className="notfound-reason">
            No page with that address exists. The link may be out of date, or the material behind it was deleted.
            Your library is untouched.
          </p>
        </div>

        <div className="row wrap gap-2 center notfound-actions">
          <Link to="/app" className="btn btn-primary">
            <Icon name="grid_view" size={18} />
            Go to your library
          </Link>
          <Link to="/" className="btn btn-ghost">
            Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}
