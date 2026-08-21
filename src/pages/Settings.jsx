import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePrefs, THEMES, FONT_SIZES } from '../lib/prefs.jsx';
import { useAuth } from '../lib/auth.jsx';
import { useStore } from '../lib/store.jsx';
import { api, isDemo } from '../lib/api.js';
import { Icon, Modal, Segmented, useToast } from '../components/ui.jsx';
import Mascot from '../components/mascot/Mascot.jsx';
import FaceEnrolment from '../components/auth/FaceEnrolment.jsx';
import '../components/auth/auth-methods.css';
import './settings.css';

/**
 * Settings.
 *
 * Laid out as a settings menu rather than a column of essays: every preference
 * is one row — name, one line of explanation, control on the right, always in
 * the same place. The explanations stay because few of these choices are
 * self-evident, but they are one line each now.
 */

/** One preference. The control sits in its own column so rows line up. */
function Row({ title, hint, children, stacked = false }) {
  return (
    <div className={`setting-row ${stacked ? 'is-stacked' : ''}`}>
      <div className="setting-copy">
        <strong>{title}</strong>
        {hint && <span>{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Section({ title, icon, children }) {
  return (
    <section className="panel settings-card">
      <header className="settings-card-head">
        <span className="settings-card-icon">
          <Icon name={icon} size={18} />
        </span>
        <h2>{title}</h2>
      </header>
      <div className="setting-rows">{children}</div>
    </section>
  );
}

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className={`toggle ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={checked && !disabled} onChange={onChange} disabled={disabled} aria-label={label} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

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
        <Mascot state="idle" size={140} shadow={false} />
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

      {/* ---------------------------------------------------- appearance -- */}
      <Section title="Appearance" icon="palette">
        <Row title="Theme" hint="Where SmartRecap uses dark and where it uses light." stacked>
          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={prefs.theme === t.value}
                className={`theme-card ${prefs.theme === t.value ? 'is-on' : ''}`}
                onClick={() => prefs.set({ theme: t.value })}
              >
                <span className="theme-swatch" aria-hidden="true">
                  {t.swatch.map((c, i) => (
                    <i key={i} style={{ background: c }} />
                  ))}
                </span>
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
                {prefs.theme === t.value && (
                  <span className="theme-tick">
                    <Icon name="check" size={13} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </Row>

        <Row title="Text size" hint="Scales the text without shrinking the buttons around it.">
          <Segmented
            label="Text size"
            value={prefs.fontSize}
            onChange={(v) => prefs.set({ fontSize: v })}
            options={FONT_SIZES.map((f) => ({ value: f.value, label: f.label }))}
          />
        </Row>

        <Row title="Reading typeface" hint="Atkinson Hyperlegible is designed for low-vision reading.">
          <Segmented
            label="Reading typeface"
            value={prefs.readingFont}
            onChange={(v) => prefs.set({ readingFont: v })}
            options={[
              { value: 'default', label: 'Inter' },
              { value: 'hyperlegible', label: 'Hyperlegible' },
            ]}
          />
        </Row>

        <p className="settings-sample" data-sample>
          Third Normal Form requires 2NF plus the removal of transitive dependencies: a non-key attribute must not
          depend on another non-key attribute.
        </p>
      </Section>

      {/* -------------------------------------------------------- motion -- */}
      <Section title="Motion" icon="animation">
        <Row
          title="Animation"
          hint="On Reduced, animated backgrounds and the 3D assistant switch off completely rather than just slowing down."
        >
          <Segmented
            label="Motion"
            value={prefs.motion}
            onChange={(v) => prefs.set({ motion: v })}
            options={[
              { value: 'full', label: 'Full' },
              { value: 'reduced', label: 'Reduced' },
            ]}
          />
        </Row>

        <Row title="Animated backgrounds" hint="The moving colour and light behind each screen.">
          <Toggle
            checked={prefs.effects}
            disabled={prefs.reduced}
            onChange={() => prefs.toggle('effects')}
            label="Animated backgrounds"
          />
        </Row>

        <Row title="Show Rec, the 3D assistant" hint="Rec reacts to what SmartRecap is doing and to your quiz results.">
          <Toggle
            checked={prefs.mascot}
            disabled={prefs.reduced}
            onChange={() => prefs.toggle('mascot')}
            label="Show Rec"
          />
        </Row>

        {prefs.reduced && (
          <p className="settings-note">
            <Icon name="info" size={15} />
            Reduced motion is on, so both switches above are held off regardless of their position.
          </p>
        )}
      </Section>

      <FaceEnrolment isGuest={isGuest} />

      {/* ------------------------------------------------------- account -- */}
      <Section title="Account" icon="person">
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
            <dd>{isGuest ? 'Guest session' : user?.provider === 'google' ? 'Google' : 'Email and password'}</dd>
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
            onClick={() => {
              prefs.reset();
              toast.success('Appearance reset to defaults.');
            }}
          >
            <Icon name="settings_backup_restore" size={16} />
            Reset appearance
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
      </Section>

      {/* ------------------------------------------------------- privacy -- */}
      <Section title="Your files and your privacy" icon="lock">
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
      </Section>

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
