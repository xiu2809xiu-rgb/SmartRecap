import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout.jsx';
import { Icon, Spinner } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';
import GoogleButton from '../components/auth/GoogleButton.jsx';
import FaceSignIn from '../components/auth/FaceSignIn.jsx';
import useFaceAvailability from '../components/auth/useFaceAvailability.js';
import '../components/auth/auth-methods.css';

export default function Login() {
  const { login, loginWithGoogle, loginWithFace } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [faceOpen, setFaceOpen] = useState(false);
  const faceAvailable = useFaceAvailability();

  const from = location.state?.from ?? '/app';
  const go = () => navigate(from, { replace: true });

  const onSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(form);
      go();
    } catch (err) {
      setError(err.status === 401 ? 'We couldn’t sign you in with those details. Check your email and password, or create an account.' : (err.message ?? 'Sign in failed.'));
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async (credential) => {
    setError(null);
    await loginWithGoogle(credential);
    go();
  };

  // Thrown back to FaceSignIn on purpose: the modal owns the retry UI, and it
  // needs the failure to stay in its own state machine rather than being
  // reported behind it on a page the user cannot see.
  const onFace = async (image) => {
    await loginWithFace(image);
    setTimeout(go, 900);
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to pick up your recaps, quizzes and study streak where you left them."
      mascotState="idle"
      footer={
        <>
          New here? <Link to="/signup">Create an account</Link>
        </>
      }
      methods={
        <div className="auth-methods">
          <GoogleButton onCredential={onGoogle} onError={setError} disabled={busy} />
          {faceAvailable && (
            <button type="button" className="face-btn" onClick={() => setFaceOpen(true)} disabled={busy}>
              <Icon name="face_retouching_natural" size={19} />
              Sign in with your face
            </button>
          )}
        </div>
      }
    >
      <form className="auth-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
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
          <label htmlFor="login-password">Password</label>
          <div className="input-affix">
            <input
              id="login-password"
              className="input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <button
              type="button"
              className="affix-btn"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={18} />
            </button>
          </div>
        </div>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? <Spinner size={17} /> : null}
          Sign in
        </button>
      </form>

      <FaceSignIn open={faceOpen} onClose={() => setFaceOpen(false)} onCapture={onFace} mode="signin" />
    </AuthLayout>
  );
}
