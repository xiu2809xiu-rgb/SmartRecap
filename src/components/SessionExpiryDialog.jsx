import { Icon, Modal } from './ui.jsx';
import { useSession } from '../lib/session.jsx';
import './session-dialog.css';

/**
 * "Still there?" — shown an hour into a session, with five minutes to answer.
 *
 * The copy differs for guests because the consequence differs. A guest identity
 * lives in this browser's token and nothing else: signing out does not park the
 * library behind a password, it strands it. Somebody about to lose an hour of
 * work should be told that in the dialog, not discover it at the login screen.
 */

function countdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function SessionExpiryDialog() {
  const { warning, remainingMs, extend, endSession, isGuest } = useSession();

  if (!warning) return null;

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const proportion = Math.max(0, Math.min(1, remainingMs / (5 * 60 * 1000)));

  return (
    <Modal
      open
      // The two buttons are the only ways out; see Modal's note on why.
      dismissible={false}
      title="Still there?"
      width={470}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={() => endSession('manual')}>
            Sign out now
          </button>
          <button type="button" className="btn btn-primary" onClick={extend} autoFocus>
            <Icon name="check" size={18} />
            I&rsquo;m still here
          </button>
        </>
      }
    >
      <div className="session-dialog">
        <div className="session-ring" role="timer" aria-live="off">
          {/* The ring drains anticlockwise as the grace period runs down. */}
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle className="session-ring-track" cx="60" cy="60" r="52" />
            <circle
              className="session-ring-value"
              cx="60"
              cy="60"
              r="52"
              style={{ strokeDashoffset: 327 * (1 - proportion) }}
            />
          </svg>
          <strong className="num">{countdown(remainingMs)}</strong>
        </div>

        <div className="session-dialog-copy">
          <p>
            You have been signed in for an hour. To keep this browser safe on a shared machine,
            SmartRecap signs you out unless you confirm you are still here.
          </p>
          <p className="session-dialog-consequence">
            {isGuest ? (
              <>
                <Icon name="warning" size={17} />
                <span>
                  This is a guest session. Signing out ends it for good — the library in this browser
                  cannot be signed back into. Create an account first if you want to keep it.
                </span>
              </>
            ) : (
              <>
                <Icon name="info" size={17} />
                <span>
                  Anything still generating keeps running on the server, and will be waiting in your
                  library next time you sign in.
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {/* One polite announcement, rather than a live region reading out every
          second of the countdown to a screen reader. */}
      <p className="sr-only" role="status">
        Your session ends in {Math.ceil(seconds / 60)} minutes unless you confirm you are still here.
      </p>
    </Modal>
  );
}
