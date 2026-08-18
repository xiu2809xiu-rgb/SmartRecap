/**
 * Google Identity Services.
 *
 * GIS is script-loaded rather than an npm package — Google does not ship a
 * bundleable SDK for the browser, and the script has to come from their origin
 * so the credential is issued against a domain they can verify.
 *
 * What comes back is an ID token (a signed JWT). It is NOT trusted here: the
 * browser hands it straight to `POST /auth/google`, and the server verifies the
 * signature, the audience and the expiry before it will create a session. A
 * client that verified its own login token would be checking its own homework.
 */

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? '';
export const isGoogleConfigured = !!GOOGLE_CLIENT_ID;

let scriptPromise = null;

function loadScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.google?.accounts?.id) return Promise.resolve(window.google);

  scriptPromise ??= new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement('script');

    const onLoad = () => {
      if (window.google?.accounts?.id) resolve(window.google);
      else reject(new Error('Google Identity Services loaded but did not initialise.'));
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => {
        // Reset so a later attempt can retry rather than being stuck on a
        // rejected promise — this fails on flaky wifi more than anything else.
        scriptPromise = null;
        reject(new Error('Could not reach Google. Check your connection, or sign in with your email instead.'));
      },
      { once: true },
    );

    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

/**
 * Opens Google's account chooser and resolves with the ID token.
 *
 * Uses the popup flow rather than One Tap. One Tap is dismissible in ways that
 * are hard to distinguish from failure, and on a login screen the user has
 * already declared intent by clicking — a chooser is the honest response to
 * that, and it works in browsers that block third-party cookies.
 */
/**
 * Google rejects an unregistered origin inside its own popup window, with
 * `Error 400: origin_mismatch`. The app never sees it — no callback fires, so
 * there is nothing to catch and nothing to explain. The best we can do is say,
 * once and early, exactly which origin has to be registered, so the next person
 * who hits it has the answer in the console rather than in a Chinese-language
 * Google error page.
 */
function warnAboutOrigin() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  console.info(
    `[SmartRecap] Google sign-in will only work if this exact origin is listed under ` +
      `"Authorised JavaScript origins" for client ${GOOGLE_CLIENT_ID.slice(0, 24)}… — ` +
      `current origin: ${window.location.origin}`,
  );
}

export async function requestGoogleCredential() {
  if (!isGoogleConfigured) {
    throw new Error('Google sign-in is not configured for this deployment.');
  }

  warnAboutOrigin();
  const google = await loadScript();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    try {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          if (response?.credential) finish(resolve, response.credential);
          else finish(reject, new Error('Google did not return a credential.'));
        },
        cancel_on_tap_outside: true,
        auto_select: false,
        use_fedcm_for_prompt: true,
      });

      // `prompt` reports why it did not show. Treating "not displayed" as a
      // silent no-op leaves the button spinning forever, so it is surfaced.
      google.accounts.id.prompt((notification) => {
        if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
          const reason = notification.getNotDisplayedReason?.() ?? notification.getSkippedReason?.() ?? '';
          finish(
            reject,
            new Error(
              reason === 'suppressed_by_user'
                ? 'Google sign-in was dismissed. Try again, or use your email.'
                : 'Google could not show its sign-in prompt in this browser. Use your email instead.',
            ),
          );
        }
      });
    } catch (e) {
      finish(reject, e instanceof Error ? e : new Error('Google sign-in failed to start.'));
    }
  });
}

/** Clears GIS's cached session so the next sign-in shows the chooser again. */
export function disableGoogleAutoSelect() {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    /* GIS was never loaded — nothing to clear */
  }
}
