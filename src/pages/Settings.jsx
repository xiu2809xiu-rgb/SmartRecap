import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePrefs } from '../lib/prefs.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { api, isDemo } from '../lib/api.js';
import { Icon, Modal, Segmented, useToast } from '../components/ui.jsx';
import Mascot from '../mascot/Mascot.jsx';
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
              {attempts.length === 1 ? 'attempt' : 'attempts'} live under a temporary identity tied to this browser.
              Create an account to reach them from your phone, and to stop a cleared cache from taking them with it.
            </p>
          </div>
          <Link to="/signup" className="btn btn-primary">
            <Icon name="person_add" size={18} />
            Create an account
          </Link>
        </section>
      )}

      {/* ------------------------------------------------------ motion ---- */}
      <section className="panel settings-card">
        <div className="settings-row">
          <div>
            <h2>Motion and effects</h2>
            <p>
              SmartRecap runs WebGL backgrounds and a 3D mascot. On <strong>Reduced</strong> they are not slowed down —
              they are removed, and no GPU context is created at all. Your system's reduced-motion setting picks the
              default.
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
          hint="The aurora mesh, threads and particle fields behind each screen."
          checked={prefs.effects}
          disabled={prefs.reduced}
          onChange={() => prefs.toggle('effects')}
        />

        <Toggle
          label="Show Rec, the 3D assistant"
          hint="Rec reacts to what the pipeline is doing and to your quiz results. Turning this off falls back to a flat badge."
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
              The recap reader uses a light surface at 17px with a 74-character measure. If a different typeface reads
              better for you, switch it here — it applies to the whole app.
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
            <dd>{isGuest ? 'Guest session — no email' : user?.email}</dd>
          </div>
          <div>
            <dt>Identity provider</dt>
            <dd>{isDemo ? 'Demo mode (browser storage)' : 'Amazon Cognito user pool'}</dd>
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

      {/* ------------------------------------------------------ pipeline -- */}
      <section className="panel settings-card">
        <h2>How your files are handled</h2>
        <ul className="settings-facts">
          <li>
            <Icon name="lock" size={18} />
            <div>
              <strong>Uploads go straight to a private S3 bucket</strong>
              <span>
                The browser gets a presigned PUT URL valid for five minutes. The file never passes through an
                application server, and the bucket blocks all public access.
              </span>
            </div>
          </li>
          <li>
            <Icon name="content_cut" size={18} />
            <div>
              <strong>Only extracted text reaches the model</strong>
              <span>
                Lambda pulls the text layer out, splits it into numbered chunks, and sends those. The original file is
                never forwarded to the AI provider.
              </span>
            </div>
          </li>
          <li>
            <Icon name="key_off" size={18} />
            <div>
              <strong>No API key reaches the browser</strong>
              <span>
                Provider keys live in Lambda environment variables. Every model call is made server-side, which is also
                why demo mode cannot generate recaps.
              </span>
            </div>
          </li>
          <li>
            <Icon name="delete" size={18} />
            <div>
              <strong>Deleting a material deletes the file</strong>
              <span>The S3 object, the DynamoDB records, the chunks and the attempt history all go together.</span>
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
