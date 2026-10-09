import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthVisual from '../components/AuthVisual';
import { apiAuthBootstrap, apiLogin } from '../api/fetch';
import '../styles/login.css';

export default function LoginPage({ onLogin }) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false); // no accounts exist yet
  const formRef = useRef(null);

  // A fresh install has no accounts; send the first visitor to setup.
  useEffect(() => {
    let alive = true;
    apiAuthBootstrap()
      .then((b) => { if (alive && !b.hasUsers) setNeedsSetup(true); })
      .catch(() => { /* leave the login form up; the error surfaces on submit */ });
    return () => { alive = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;

    setLoading(true);
    setError('');

    const username = formRef.current.username.value;
    const password = formRef.current.password.value;

    try {
      const { user } = await apiLogin(username, password);
      if (onLogin) onLogin(user);
      else window.location.href = '/app';
    } catch (err) {
      setError(err?.message || 'The provided credentials are invalid.');
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-wrapper">
        <AuthVisual
          headline={<>Storage so<br />reliable, you&apos;ll never <span>think about it.</span></>}
        />

        <div className="form-side">
          <div className="form-header">
            <h2>{needsSetup ? 'Set up this server' : 'Sign in to Velocity'}</h2>
            <p></p>
          </div>

          {error && (
            <div className="error-message show">{error}</div>
          )}

          {needsSetup ? (
            <div>
              <p className="form-note">
                No accounts exist on this server yet. Create the first one, which becomes
                the owner account, with full access to every drive and the ability to
                manage everyone else&apos;s.
              </p>
              <button type="button" className="login-button" onClick={() => navigate('/signup')}>
                <span>Create the owner account</span>
              </button>
            </div>
          ) : (
            <form ref={formRef} onSubmit={handleSubmit}>
              <div className="input-group">
                <label htmlFor="username">Username</label>
                <input type="text" id="username" name="username" className="input-field" placeholder="Username" autoComplete="username" required />
              </div>

              <div className="input-group">
                <label htmlFor="password">Password</label>
                <input type="password" id="password" name="password" className="input-field" placeholder="••••••••" autoComplete="current-password" required />
              </div>

              <button type="submit" className="login-button" disabled={loading}>
                {loading ? (
                  <span className="login-loader" style={{ display: 'block' }}></span>
                ) : (
                  <span>Login</span>
                )}
              </button>

              <div className="form-alt">
                Don&apos;t have an account?{' '}
                <button type="button" className="link-button" onClick={() => navigate('/signup')}>
                  Create one
                </button>
              </div>
            </form>
          )}

          <div className="form-footer"></div>
        </div>
      </div>
    </div>
  );
}
