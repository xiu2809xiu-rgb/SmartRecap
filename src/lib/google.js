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

/**
 * Which mount currently owns a container.
 *
 * `mountGoogleButton` is async, and React StrictMode mounts an effect, unmounts
 * it and mounts it again — so in development two calls are in flight over the
 * same element at once. Both draw; then the first one's teardown resolves last
 * and clears the button the second one had just drawn, leaving an empty
 * container that reported `ready`. A stale run must not clear, or redraw into,
 * a container a newer run has taken over.
 */
const owners = new WeakMap();

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
 * Google rejects an unregistered origin inside its own popup window, with
 * `Error 400: origin_mismatch`. The app never sees it — no callback fires, so
 * there is nothing to catch and nothing to explain. The best we can do is say,
 * once and early, exactly which origin has to be registered, so the next person
 * who hits it has the answer in the console rather than in a Google error page
 * in a language they may not read.
 */
function warnAboutOrigin() {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  console.info(
    `[SmartRecap] Google sign-in will only work if this exact origin is listed under ` +
      `"Authorised JavaScript origins" for client ${GOOGLE_CLIENT_ID.slice(0, 24)}… — ` +
      `current origin: ${window.location.origin}`,
  );
}

/** GIS takes an integer width in px and ignores anything over 400. */
function buttonWidth(container) {
  const measured = Math.round(container.getBoundingClientRect().width);
  return Math.max(200, Math.min(400, measured || 320));
}

/**
 * Renders Google's own sign-in button into `container` and calls
 * `onCredential` with the ID token once someone signs in.
 *
 * This is the button flow, not One Tap. The distinction is the whole point of
 * this function, because the two look nothing alike:
 *
 *   One Tap (`google.accounts.id.prompt`) is what this used to call. Under
 *   FedCM the browser — not the page — draws it, as a small chip pinned to the
 *   top-right corner saying "Sign in to localhost with google.com". It is
 *   Chrome's own UI, so it cannot be styled, it is easy to miss, and it looks
 *   nothing like the account chooser people recognise as signing in with
 *   Google.
 *
 *   The button flow opens the real thing: a popup window on accounts.google.com
 *   with the account list, the avatars and the "Choose an account" heading.
 *
 * Both hand back the same signed ID token through the same callback, so the
 * server side of this is unchanged — `POST /auth/google` still verifies the
 * JWT against Google's JWKS before it will create a session.
 *
 * The button has to be rendered by Google rather than drawn by us: GIS builds
 * it inside its own element and attaches the click handler itself, and there is
 * no supported way to trigger the chooser from an arbitrary button. That is
 * also what Google's branding rules ask for, so the trade is a fair one.
 *
 * Returns a cleanup function.
 */
export async function mountGoogleButton(container, { onCredential, onError }) {
  if (!isGoogleConfigured) {
    throw new Error('Google sign-in is not configured for this deployment.');
  }

  warnAboutOrigin();
  const google = await loadScript();

  // Claimed after the await, so the run that draws last is the run that owns
  // the container.
  const token = {};
  owners.set(container, token);

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: (response) => {
      if (response?.credential) onCredential(response.credential);
      else onError?.(new Error('Google did not return a credential.'));
    },
    auto_select: false,
    cancel_on_tap_outside: true,
    // Ask for the classic popup rather than the browser-drawn FedCM dialog.
    // This is the flag that decides which of the two UIs above appears.
    use_fedcm_for_button: false,
    use_fedcm_for_prompt: false,
    // Safari and other ITP browsers partition the storage GIS would otherwise
    // use to remember the session.
    itp_support: true,
  });

  // The width the button was last drawn at. Redrawing is only correct when this
  // changes; see the observer below for why that distinction matters.
  let drawnWidth = 0;

  const draw = () => {
    if (owners.get(container) !== token) return;
    drawnWidth = buttonWidth(container);
    // renderButton appends; without clearing, a re-render on resize would stack
    // a second button under the first.
    container.replaceChildren();
    google.accounts.id.renderButton(container, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: drawnWidth,
      // Without this GIS picks the browser's or the Google account's language,
      // so the one control on the page that Google draws could come back in a
      // different language from everything around it.
      locale: 'en',
    });
  };

  draw();

  // The button's width is baked in at render time, so it has to be redrawn when
  // the column changes width — a phone rotating, or the font-size setting
  // moving every rem on the page.
  //
  // Only on width. ResizeObserver reports height as well, and GSI restyles its
  // own iframe continuously, which nudges the container's height. Redrawing on
  // that fed straight back into itself: tear down, render a new iframe, the new
  // iframe changes height, observe, tear down again — about eight rebuilds a
  // second for as long as the page was open, which is what made the sign-in
  // page flicker.
  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (buttonWidth(container) === drawnWidth) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  observer.observe(container);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    // A newer mount owns the container — its button is the live one, so leave
    // it alone. Clearing here is what emptied the host under StrictMode.
    if (owners.get(container) !== token) return;
    owners.delete(container);
    container.replaceChildren();
  };
}

/** Clears GIS's cached session so the next sign-in shows the chooser again. */
export function disableGoogleAutoSelect() {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    /* GIS was never loaded — nothing to clear */
  }
}
