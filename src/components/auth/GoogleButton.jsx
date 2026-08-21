import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../ui.jsx';
import { isGoogleConfigured, mountGoogleButton } from '../../lib/google.js';
import { isDemo } from '../../lib/api.js';

/**
 * "Continue with Google".
 *
 * When a client id is configured this hands the whole control over to Google:
 * `mountGoogleButton` has GIS render its own button here, and clicking it opens
 * the account chooser people recognise — a real popup window on
 * accounts.google.com, not the corner chip the browser draws for One Tap.
 *
 * That is why this component no longer draws its own button in the live case.
 * GIS attaches the click handler to an element it builds itself, and there is
 * no supported way to open the chooser from a button of ours; a custom button
 * can only ever reach One Tap. Google's branding rules point the same way, so
 * the styling we give up buys back the flow the user expects.
 *
 * The custom button below is still used, but only where no real chooser can
 * open:
 *   demo mode             → visible and simulated, so the team can see the
 *                           design without a client id
 *   live + not configured → disabled, with a note saying why
 */

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

/** The live flow: Google's own button, and the chooser popup behind it. */
function GoogleHostedButton({ onCredential, onError }) {
  const hostRef = useRef(null);
  const [status, setStatus] = useState('loading');

  // Kept in a ref so the GIS callback always reaches the current handlers.
  // GIS is initialised once per mount; without this it would close over the
  // props from that first render and go stale.
  const handlers = useRef({ onCredential, onError });
  handlers.current = { onCredential, onError };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cleanup;
    let cancelled = false;

    mountGoogleButton(host, {
      onCredential: (credential) => handlers.current.onCredential?.(credential),
      onError: (e) => handlers.current.onError?.(e?.message ?? 'Google sign-in failed.'),
    })
      .then((teardown) => {
        if (cancelled) {
          teardown();
          return;
        }
        cleanup = teardown;
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus('failed');
        handlers.current.onError?.(e?.message ?? 'Could not load Google sign-in.');
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="google-host-wrap">
      <div className="google-host" ref={hostRef} data-status={status} />
      {status === 'loading' && (
        <p className="google-demo-note" role="status">
          <Spinner size={15} /> Loading Google sign-in…
        </p>
      )}
      {status === 'failed' && (
        <p className="google-demo-note">
          Google sign-in could not load. Use your email and password instead.
        </p>
      )}
    </div>
  );
}

export default function GoogleButton({ onCredential, onError, disabled, label = 'Continue with Google' }) {
  const [busy, setBusy] = useState(false);

  if (isGoogleConfigured) {
    return <GoogleHostedButton onCredential={onCredential} onError={onError} />;
  }

  const run = async () => {
    if (!isDemo) return;
    setBusy(true);
    try {
      // Demo mode: no client id, so no real chooser. The sentinel is recognised
      // by the demo backend and by nothing else.
      await new Promise((r) => setTimeout(r, 700));
      await onCredential('demo-google-credential');
    } catch (e) {
      onError?.(e?.message ?? 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="google-btn"
        onClick={run}
        disabled={busy || disabled || !isDemo}
        aria-describedby={!isDemo ? 'google-setup-note' : undefined}
      >
        {busy ? <Spinner size={18} /> : <GoogleMark />}
        <span>{busy ? 'Opening Google…' : label}</span>
      </button>
      {isDemo ? (
        <p className="google-demo-note">Demo mode uses a clearly marked placeholder Google account.</p>
      ) : (
        <p className="google-demo-note" id="google-setup-note">
          Google sign-in is visible but unavailable until an administrator finishes setup.
        </p>
      )}
    </>
  );
}
