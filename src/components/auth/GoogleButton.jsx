import { useState } from 'react';
import { Spinner } from '../ui.jsx';
import { isGoogleConfigured, requestGoogleCredential } from '../../lib/google.js';
import { isDemo } from '../../lib/api.js';

/**
 * "Continue with Google".
 *
 * The mark and the wording follow Google's branding requirements: their
 * four-colour G, unmodified, on a white surface, with the sanctioned phrasing.
 * The button is styled to sit in this design but nothing about the logo or the
 * label is customised, because those are the parts Google does not allow you to
 * change.
 *
 * Rendering rules:
 *   configured            → the real flow
 *   demo mode             → visible and simulated, so the team can see the
 *                           design without a client id
 *   live + not configured → hidden, rather than shown broken to a real student
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

export default function GoogleButton({ onCredential, onError, disabled, label = 'Continue with Google' }) {
  const [busy, setBusy] = useState(false);

  const configured = isGoogleConfigured || isDemo;

  const run = async () => {
    if (!configured) return;
    setBusy(true);
    try {
      if (!isGoogleConfigured) {
        // Demo mode: no client id, so no real chooser. The sentinel is
        // recognised by the demo backend and by nothing else.
        await new Promise((r) => setTimeout(r, 700));
        await onCredential('demo-google-credential');
        return;
      }
      await onCredential(await requestGoogleCredential());
    } catch (e) {
      onError?.(e?.message ?? 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="google-btn" onClick={run} disabled={busy || disabled || !configured} aria-describedby={!configured ? 'google-setup-note' : undefined}>
        {busy ? <Spinner size={18} /> : <GoogleMark />}
        <span>{busy ? 'Opening Google…' : label}</span>
      </button>
      {!configured ? (
        <p className="google-demo-note" id="google-setup-note">Google sign-in is visible but unavailable until an administrator finishes setup.</p>
      ) : !isGoogleConfigured ? (
        <p className="google-demo-note">Demo mode uses a clearly marked placeholder Google account.</p>
      ) : null}
    </>
  );
}
