import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Spinner } from '../ui.jsx';

/**
 * Face sign-in.
 *
 * Frontend only — the matching itself is the backend's job. What this owns is
 * the camera, the consent, and every way it can go wrong.
 *
 * Two decisions worth keeping:
 *
 * **Consent comes before the camera.** The stream is not requested until the
 * student has read what happens to the image and pressed a button. A biometric
 * prompt that fires the moment a modal opens teaches people to click through
 * permission dialogs, and it is the one thing you should not teach them.
 *
 * **The stream is torn down on every exit path.** Close, cancel, success,
 * error, unmount, tab hidden. A camera light left on after a failed login is
 * both a privacy problem and the thing users remember about your app.
 *
 * The backend contract is in docs/FACE-AUTH-CONTRACT.md.
 */

const STATES = {
  intro: 'intro',
  requesting: 'requesting',
  ready: 'ready',
  countdown: 'countdown',
  matching: 'matching',
  success: 'success',
  error: 'error',
};

const CAPTURE_SIZE = 480; // square, square-cropped from the centre of the frame
const COUNTDOWN_FROM = 3;

export default function FaceSignIn({ open, onClose, onCapture, mode = 'signin' }) {
  const [state, setState] = useState(STATES.intro);
  const [error, setError] = useState(null);
  const [count, setCount] = useState(COUNTDOWN_FROM);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timers = useRef([]);

  const isEnrol = mode === 'enrol';

  /* ------------------------------------------------------------- teardown */

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const stopCamera = useCallback(() => {
    clearTimers();
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [clearTimers]);

  // Every unmount, and every close, releases the camera.
  useEffect(() => stopCamera, [stopCamera]);

  useEffect(() => {
    if (!open) {
      stopCamera();
      setState(STATES.intro);
      setError(null);
    }
  }, [open, stopCamera]);

  // Backgrounding the tab should not leave the camera live.
  useEffect(() => {
    if (!open) return undefined;
    const onHide = () => {
      if (document.hidden && streamRef.current) {
        stopCamera();
        setState(STATES.intro);
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [open, stopCamera]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const close = () => {
    stopCamera();
    onClose?.();
  };

  /* --------------------------------------------------------------- camera */

  const startCamera = async () => {
    setError(null);
    setState(STATES.requesting);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot use the camera. Sign in with your email instead.');
      setState(STATES.error);
      return;
    }
    // getUserMedia is unavailable outside a secure context, which is the usual
    // cause when this works locally and fails on a deployed HTTP host.
    if (!window.isSecureContext) {
      setError('The camera only works over HTTPS. Sign in with your email instead.');
      setState(STATES.error);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setState(STATES.ready);
    } catch (e) {
      const name = e?.name ?? '';
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera access was blocked. Allow it in your browser settings, or sign in with your email.'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'No camera was found on this device.'
            : name === 'NotReadableError'
              ? 'Your camera is already in use by another app.'
              : 'The camera could not be started. Sign in with your email instead.',
      );
      setState(STATES.error);
    }
  };

  /* -------------------------------------------------------------- capture */

  const grabFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;

    // Square centre crop, so the payload does not carry the whole room and the
    // backend always receives a consistent aspect ratio.
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = CAPTURE_SIZE;
    canvas.height = CAPTURE_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
    return canvas.toDataURL('image/jpeg', 0.82);
  };

  const runCountdown = () => {
    setState(STATES.countdown);
    setCount(COUNTDOWN_FROM);
    for (let i = 1; i <= COUNTDOWN_FROM; i += 1) {
      timers.current.push(setTimeout(() => setCount(COUNTDOWN_FROM - i), i * 800));
    }
    timers.current.push(setTimeout(submit, COUNTDOWN_FROM * 800 + 120));
  };

  const submit = async () => {
    const image = grabFrame();
    if (!image) {
      setError('The camera did not produce a usable frame. Try again.');
      setState(STATES.error);
      return;
    }

    setState(STATES.matching);
    // Released as soon as there is a frame — the match does not need the camera,
    // and holding it open during a network call is the wrong default.
    stopCamera();

    try {
      await onCapture(image);
      setState(STATES.success);
    } catch (e) {
      setError(e?.message ?? 'That did not match a saved face.');
      setState(STATES.error);
    }
  };

  if (!open) return null;

  const showStage = [STATES.requesting, STATES.ready, STATES.countdown].includes(state);

  return createPortal(
    <div className="face-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="face-modal panel-solid" role="dialog" aria-modal="true" aria-label={isEnrol ? 'Set up face sign-in' : 'Sign in with your face'}>
        <header className="face-head">
          <div>
            <h2>{isEnrol ? 'Set up face sign-in' : 'Sign in with your face'}</h2>
            <p>{isEnrol ? 'One photo, so SmartRecap can recognise you next time.' : 'Look at the camera and hold still.'}</p>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>

        <div className="face-body">
          {/* ------------------------------------------------------ consent */}
          {state === STATES.intro && (
            <div className="face-intro">
              <span className="face-intro-icon">
                <Icon name="face_retouching_natural" size={30} />
              </span>
              <ul className="face-facts">
                <li>
                  <Icon name="photo_camera" size={17} />
                  <span>Your camera turns on only after you press the button below, and switches off the moment a photo is taken.</span>
                </li>
                <li>
                  <Icon name="cloud_upload" size={17} />
                  <span>
                    {isEnrol
                      ? 'One photo is sent to SmartRecap and kept so it can recognise you later. You can remove it in Settings at any time.'
                      : 'One photo is sent to SmartRecap to compare against the face you saved. It is not kept.'}
                  </span>
                </li>
                <li>
                  <Icon name="alternate_email" size={17} />
                  <span>You can always sign in with your email instead — face sign-in is a shortcut, never the only way in.</span>
                </li>
              </ul>
              <div className="face-actions">
                <button className="btn btn-ghost" onClick={close}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={startCamera}>
                  <Icon name="videocam" size={18} />
                  Turn on my camera
                </button>
              </div>
            </div>
          )}

          {/* -------------------------------------------------------- stage */}
          {showStage && (
            <div className="face-stage">
              <div className={`face-frame ${state === STATES.ready || state === STATES.countdown ? 'is-live' : ''}`}>
                {/* Mirrored, because an unmirrored selfie view makes people move
                    the wrong way when they try to centre themselves. */}
                <video ref={videoRef} className="face-video" playsInline muted autoPlay />
                <div className="face-oval" aria-hidden="true" />
                <div className="face-scan" aria-hidden="true" />
                <div className="face-corners" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                {state === STATES.requesting && (
                  <div className="face-overlay">
                    <Spinner size={22} />
                    <span>Waiting for camera permission…</span>
                  </div>
                )}
                {state === STATES.countdown && (
                  <div className="face-count" aria-live="assertive">
                    {count > 0 ? count : <Icon name="photo_camera" size={40} />}
                  </div>
                )}
              </div>

              {state === STATES.ready && (
                <div className="face-actions">
                  <button className="btn btn-ghost" onClick={close}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={runCountdown}>
                    <Icon name="center_focus_strong" size={18} />
                    {isEnrol ? 'Take my photo' : 'Scan my face'}
                  </button>
                </div>
              )}
              {state === STATES.countdown && <p className="face-hint">Hold still — centre your face in the oval.</p>}
            </div>
          )}

          {/* ------------------------------------------------------ matching */}
          {state === STATES.matching && (
            <div className="face-result">
              <div className="face-pulse" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <strong>{isEnrol ? 'Saving your face…' : 'Checking your face…'}</strong>
              <p>This usually takes a second.</p>
            </div>
          )}

          {state === STATES.success && (
            <div className="face-result is-good" role="status">
              <span className="face-result-icon">
                <Icon name="check" size={30} />
              </span>
              <strong>{isEnrol ? 'Face saved' : 'Welcome back'}</strong>
              <p>{isEnrol ? 'You can now sign in with your face.' : 'Taking you to your library.'}</p>
            </div>
          )}

          {state === STATES.error && (
            <div className="face-result is-bad" role="alert">
              <span className="face-result-icon">
                <Icon name="sentiment_dissatisfied" size={30} />
              </span>
              <strong>{isEnrol ? 'Could not save that' : 'No match'}</strong>
              <p>{error}</p>
              <div className="face-actions">
                <button className="btn btn-ghost" onClick={close}>
                  Use my email
                </button>
                <button className="btn btn-primary" onClick={startCamera}>
                  <Icon name="refresh" size={18} />
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
