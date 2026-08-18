import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon, Spinner, useToast } from '../ui.jsx';
import FaceSignIn from './FaceSignIn.jsx';

/**
 * Face sign-in setup, for Settings.
 *
 * Without this the login page offers a shortcut nobody can ever have taken —
 * you cannot sign in with a face you were never given the chance to save.
 *
 * The status call is allowed to fail quietly. Face matching is not wired up
 * yet, so a 501 here is the expected state, not an error worth interrupting
 * someone's settings page over.
 */
export default function FaceEnrolment({ isGuest }) {
  const toast = useToast();
  const [status, setStatus] = useState({ loading: true, enrolled: false, available: true });
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.auth.faceStatus();
      // `available` is the endpoint's own answer about whether the feature
      // works here. Assuming true whenever the call succeeded meant a backend
      // that answers "no" was still shown as ready, and the failure only
      // surfaced once someone had opened their camera.
      setStatus({ loading: false, enrolled: !!res?.enrolled, available: res?.available !== false });
    } catch (e) {
      // 501 means the backend has not implemented it yet; anything else means
      // it is there but unhappy. Both render as "not available right now".
      setStatus({ loading: false, enrolled: false, available: e?.status !== 501 });
    }
  }, []);

  useEffect(() => {
    if (isGuest) {
      setStatus({ loading: false, enrolled: false, available: true });
      return;
    }
    refresh();
  }, [isGuest, refresh]);

  const onCapture = async (image) => {
    await api.auth.enrolFace(image);
    await refresh();
    toast.success('Face saved. You can use it to sign in next time.');
  };

  const onRemove = async () => {
    setRemoving(true);
    try {
      await api.auth.removeFace();
      await refresh();
      toast.success('Face removed.');
    } catch (e) {
      toast.error(e?.message ?? 'Could not remove it.');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="panel settings-card">
      <header className="settings-card-head">
        <span className="settings-card-icon">
          <Icon name="face_retouching_natural" size={18} />
        </span>
        <h2>Face sign-in</h2>
      </header>

      <div className="setting-row">
        <div className="setting-copy">
          <strong>Sign in by looking at the camera</strong>
          <span>
            Save your face once and skip typing a password. Your email and password keep working either way — this is
            a shortcut, never the only way into your account.
          </span>
        </div>

        <div className="setting-control face-enrol-action">
          {status.loading ? (
            <Spinner size={20} />
          ) : isGuest ? (
            <span className="chip">Create an account first</span>
          ) : !status.available ? (
            <span className="chip chip-warn">
              <Icon name="schedule" size={13} />
              Not available yet
            </span>
          ) : status.enrolled ? (
            <div className="row gap-2">
              <span className="chip chip-good">
                <Icon name="check" size={13} />
                Saved
              </span>
              <button className="btn btn-ghost btn-sm" onClick={onRemove} disabled={removing}>
                {removing ? <Spinner size={15} /> : <Icon name="delete" size={16} />}
                Remove
              </button>
            </div>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
              <Icon name="face_retouching_natural" size={17} />
              Set it up
            </button>
          )}
        </div>
      </div>

      {status.enrolled && (
        <p className="settings-note is-quiet">
          <Icon name="lock" size={15} />
          What is stored is a numeric pattern taken from your photo, not the photo itself. Removing it deletes that
          pattern.
        </p>
      )}

      <FaceSignIn open={open} onClose={() => setOpen(false)} onCapture={onCapture} mode="enrol" />
    </section>
  );
}
