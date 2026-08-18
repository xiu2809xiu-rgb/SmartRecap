import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout.jsx';
import { Icon, Spinner } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';

/**
 * Password rules mirror the Cognito user-pool policy in
 * `backend/template.yaml`. They are checked here so a student gets the failure
 * inline rather than as a 400 from the API.
 */
const RULES = [
  { id: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'case', label: 'An uppercase and a lowercase letter', test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { id: 'num', label: 'A number', test: (p) => /\d/.test(p) },
];

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [touched, setTouched] = useState(false);

  const results = useMemo(() => RULES.map((r) => ({ ...r, ok: r.test(form.password) })), [form.password]);
  const valid = results.every((r) => r.ok) && form.email.includes('@');

  const onSubmit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await signup(form);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err.status === 409 ? 'An account already uses that email.' : (err.message ?? 'Sign up failed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Start your first recap"
      subtitle="Free while the project runs on AWS Learner Lab credits and free-tier models. No card, no model spend."
      mascotState="wave"
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="signup-name">Name</label>
          <input
            id="signup-name"
            className="input"
            autoComplete="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="How should Rec greet you?"
          />
        </div>

        <div className="field">
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@student.nyp.edu.sg"
          />
        </div>

        <div className="field">
          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <ul className="rules" aria-live="polite">
            {results.map((r) => (
              <li key={r.id} className={r.ok ? 'is-ok' : touched ? 'is-bad' : ''}>
                <Icon name={r.ok ? 'check_circle' : 'radio_button_unchecked'} size={15} />
                {r.label}
              </li>
            ))}
          </ul>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? <Spinner size={17} /> : null}
          Create account
        </button>
      </form>
    </AuthLayout>
  );
}
