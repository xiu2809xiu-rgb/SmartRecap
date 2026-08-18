import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePrefs } from '../lib/prefs.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { api, isDemo } from '../lib/api.js';
import { Icon, Modal, Segmented, useToast } from '../components/ui.jsx';
import Mascot from '../mascot/Mascot.jsx';
import FaceEnrolment from '../components/auth/FaceEnrolment.jsx';
import '../components/auth/auth-methods.css';
import './settings.css';

export default function Settings() {
  const prefs = usePrefs();
  const { user, isGuest, logout } = useAuth();
  const { materials, attempts, refresh } = useStore();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="shell settings">
      <header className="settings-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="settings-title">Make it work the way you study</h1>
        </div>
        <Mascot state={prefs.allowMascot ? 'idle' : 'idle'} size={140} shadow={false} />
      </header>

      {isGuest && (
        <section className="panel settings-card is-accent">
          <div className="grow">
            <h2>You are in a guest session</h2>
            <p>
              Your {materials.length} {materials.length === 1 ? 'material' : 'materials'} and {attempts.length}{' '}
              {attempts.length === 1 ? 'attempt' : 'attempts'} are tied to this browser. Clearing your browsing data
              would take them with it. Create an account and they move across with you — nothing is lost, and you can
              pick them up on your phone.
            </p>
          </div>
          <Link to="/signup" className="btn btn-primary">
            <Icon name="person_add" size={18} />
            Create an account
          </Link>
        </section>
      )}

      <FaceEnrolment isGuest={isGuest} />

      {/* ------------------------------------------------------ motion ---- */}
      <section className="panel settings-card">
        <div className="settings-row">
          <div>
            <h2>Motion and effects</h2>
            <p>
              SmartRecap uses animated backgrounds and a 3D assistant. On <strong>Reduced</strong> they are switched
              off completely rather than just slowed down, which is easier on your eyes and on your battery. Your
              device's own reduced-motion setting picks the default.
            </p>
          </div>
          <Segmented
            label="Motion"
            value={prefs.motion}
            onChange={(v) => prefs.set({ motion: v })}
            options={[
              { value: 'full', label: 'Full', icon: 'animation' },
              { value: 'reduced', label: 'Reduced', icon: 'motion_photos_off' },
            ]}
          />
        </div>

        <Toggle
          label="Animated backgrounds"
          hint="The moving colour and light behind each screen."
          checked={prefs.effects}
          disabled={prefs.reduced}
          onChange={() => prefs.toggle('effects')}
        />

        <Toggle
          label="Show Rec, the 3D assistant"
          hint="Rec reacts to what SmartRecap is doing and to your quiz results."
          checked={prefs.mascot}
          disabled={prefs.reduced}
          onChange={() => prefs.toggle('mascot')}
        />

        {prefs.reduced && (
          <p className="settings-note">
            <Icon name="info" size={15} />
            Reduced motion is on, so both switches above are held off regardless of their position.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------ reading --- */}
      <section className="panel settings-card">
        <div className="settings-row">
          <div>
            <h2>Reading</h2>
            <p>
              Recaps are shown on a light background at a comfortable reading width. If a different typeface is
              easier for you to read, switch it here — it applies everywhere.
            </p>
          </div>
          <Segmented
            label="Reading typeface"
            value={prefs.readingFont}
            onChange={(v) => prefs.set({ readingFont: v })}
            options={[
              { value: 'default', label: 'Inter' },
              { value: 'hyperlegible', label: 'Hyperlegible' },
            ]}
          />
        </div>
        <p className="settings-sample" data-sample>
          Third Normal Form requires 2NF plus the removal of transitive dependencies: a non-key attribute must not
          depend on another non-key attribute.
        </p>
      </section>

      {/* ------------------------------------------------------- account -- */}
      <section className="panel settings-card">
        <h2>Account</h2>
        <dl className="settings-dl">
          <div>
            <dt>Name</dt>
            <dd>{user?.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{isGuest ? 'None yet' : user?.email}</dd>
          </div>
          <div>
            <dt>Signed in with</dt>
            <dd>{isGuest ? 'Guest session' : 'Email and password'}</dd>
          </div>
          <div>
            <dt>Materials stored</dt>
            <dd className="num">{materials.length}</dd>
          </div>
        </dl>
        <div className="row wrap gap-2 settings-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await refresh();
              toast.success('Library reloaded.');
            }}
          >
            <Icon name="refresh" size={16} />
            Reload library
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout();
              navigate('/');
            }}
          >
            <Icon name="logout" size={16} />
            Sign out
          </button>
          {isDemo && (
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(true)}>
              <Icon name="restart_alt" size={16} />
              Reset demo data
            </button>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------- privacy -- */}
      <section className="panel settings-card">
        <h2>Your files and your privacy</h2>
        <ul className="settings-facts">
          <li>
            <Icon name="lock" size={18} />
            <div>
              <strong>Only you can open what you upload</strong>
              <span>Your files are stored privately. No other student can reach them, and none of them are public.</span>
            </div>
          </li>
          <li>
            <Icon name="content_cut" size={18} />
            <div>
              <strong>Only the text is read</strong>
              <span>
                SmartRecap pulls the words out of your file and works from those. The file itself is never handed to
                the AI.
              </span>
            </div>
          </li>
          <li>
            <Icon name="visibility" size={18} />
            <div>
              <strong>The text is sent to an outside AI service</strong>
              <span>
                That is how the recap gets written. The free services SmartRecap uses may keep requests to improve
                their own models, so treat anything you upload as if it could be seen — do not upload confidential or
                personal documents.
              </span>
            </div>
          </li>
          <li>
            <Icon name="delete" size={18} />
            <div>
              <strong>Deleting really deletes</strong>
              <span>
                Remove a material and the file, its recap, its quiz, its flashcards and your scores for it all go with
                it. Uploaded files are also cleared automatically after 30 days.
              </span>
            </div>
          </li>
        </ul>
      </section>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset demo data?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                await api._reset?.();
                await refresh();
                setConfirmReset(false);
                toast.success('Demo data reset.');
              }}
            >
              Reset
            </button>
          </>
        }
      >
        <p>
          Everything created in demo mode — uploads, attempts and flashcard schedules — is cleared, and the bundled
          sample material is restored.
        </p>
      </Modal>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange, disabled }) {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <span className="toggle-copy">
        <strong>{label}</strong>
        <span>{hint}</span>
      </span>
      <input type="checkbox" checked={checked && !disabled} onChange={onChange} disabled={disabled} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}
